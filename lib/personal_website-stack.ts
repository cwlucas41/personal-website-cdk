import { Construct } from 'constructs';
import { Stack, StackProps, Duration } from 'aws-cdk-lib';

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface DomainRecords {
  readonly MxRecords?: Omit<route53.MxRecordProps, 'zone'>[]
  readonly CnameRecords?: Omit<route53.CnameRecordProps, 'zone'>[]
  readonly TxtRecords?: Omit<route53.TxtRecordProps, 'zone'>[]
}

export interface PersonalWebsiteStackProps extends StackProps {
  readonly alarmEmail: string,
  readonly postmasterEmail: string,
  readonly apexDomain: string,
  readonly homeSubdomain: string,
  readonly websiteSubdomain: string,
  readonly records: DomainRecords,
}

interface CreateSesSqsDestinationProps {
  name: string,
  configurationSet: ses.IConfigurationSet,
  event: ses.EmailSendingEvent,
  /**
   * Determines if an alarm is created
   * @default true
   */
  alarm?: boolean
}

export class PersonalWebsiteStack extends Stack {

  alarmActions: cloudwatch.IAlarmAction[]

  constructor(scope: Construct, id: string, props: PersonalWebsiteStackProps) {
    super(scope, id, props);

    // Logging bucket retains only for limited number of days
    const accessLogBucket = new s3.Bucket(this, `access-logs-bucket`, {
      bucketName: `${id.toLowerCase()}-access-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    })

    // Alarm email mechanism
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Personal Website Alarms'
    });

    alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));

    this.alarmActions = [new cw_actions.SnsAction(alarmTopic)]

    // SES account level constructs
    new ses.VdmAttributes(this, 'ses-vdm', {
      engagementMetrics: false,
      optimizedSharedDelivery: true,
    });
    this.createSesAlarms()

    // DNSSEC
    const dnssecKey = new kms.Key(this, `${props.apexDomain}-dnssec-key`, {
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
    });

    // Apex hosted zone
    const zone = this.createHostedZone({
      domainName: props.apexDomain,
      dnssecKey
    })

    // Creates configured DNS records
    props.records.MxRecords?.forEach(recordProps =>
      new route53.MxRecord(this, `${this.domainJoin([recordProps.recordName, props.apexDomain])}-mx`, { zone, ...recordProps })
    )
    props.records.CnameRecords?.forEach(recordProps =>
      new route53.CnameRecord(this, `${this.domainJoin([recordProps.recordName, props.apexDomain])}-cname`, { zone, ...recordProps })
    )
    props.records.TxtRecords?.forEach(recordProps =>
      new route53.TxtRecord(this, `${this.domainJoin([recordProps.recordName, props.apexDomain])}-txt`, { zone, ...recordProps })
    )

    // Website hosting at website subdomain
    const websiteDomain = this.domainJoin([props.websiteSubdomain, props.apexDomain])
    this.createWebHostingInfra(zone, websiteDomain, accessLogBucket)

    // Redirect apex to website
    this.createDomainRedirectInfra(zone, props.apexDomain, websiteDomain, accessLogBucket)

    // Home subdomain zone
    const homeZone = this.createHostedZone({
      domainName: this.domainJoin([props.homeSubdomain, props.apexDomain]),
      delegatorZone: zone,
      dnssecKey
    })

    // Home subdomain email
    this.createFromEmailInfra(homeZone, `mailto:${props.postmasterEmail}`)
    this.dnsManagementIamUser(`${homeZone.zoneName}-dns-management`, [homeZone])
  }

  dnsManagementIamUser(userName: string, zones: route53.IHostedZone[]) {
    const iamUser = new iam.User(this, `iam-user-${userName}`, { userName });

    const accessKey = new iam.CfnAccessKey(this, `iam-user-${userName}-access-key`, {
      userName: iamUser.userName,
    });

    const secret = new secretsmanager.CfnSecret(this, `iam-user-${userName}-access-key-secret`, {
      name: `iam-user-${userName}-access-key`,
      secretString: JSON.stringify({
        "AccessKeyId": accessKey.ref,
        "SecretAccessKey": accessKey.attrSecretAccessKey
      })
    })

    // policy constructed for libdns
    // see https://github.com/caddy-dns/route53
    const policy = new iam.Policy(this, `${userName}-dns-management-policy`, {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "route53:ListResourceRecordSets",
            "route53:ChangeResourceRecordSets",
            "route53:GetChange",
          ],
          resources: [
            ...zones.map(zone => zone.hostedZoneArn),
            "arn:aws:route53:::change/*",
          ]
        }),
        new iam.PolicyStatement({
          actions: [
            "route53:ListHostedZonesByName",
            "route53:ListHostedZones",
          ],
          resources: ["*"]
        }),
      ]
    })

    iamUser.attachInlinePolicy(policy)
  }

  createHostedZone(props: {
    domainName: string,
    delegatorZone?: route53.PublicHostedZone,
    dnssecKey?: kms.IKey,
  }
  ): route53.PublicHostedZone {
    const zone = new route53.PublicHostedZone(this, props.domainName, { zoneName: props.domainName })

    if (props.delegatorZone) {
      props.delegatorZone.addDelegation(zone)
    }

    if (props.dnssecKey) {
      zone.enableDnssec({ kmsKey: props.dnssecKey })
      this.createDnssecAlarms(zone)
    }

    return zone
  }

  createFromEmailInfra(
    zone: route53.IHostedZone,
    dmarcRua: string,
    fromSubdomain: string = 'mail'
  ) {
    const zoneNameWithoutPeriods = zone.zoneName.replace(new RegExp(/\./g), '')

    const defaultConfigurationSet = new ses.ConfigurationSet(this, `${zone.zoneName}-default-configuration-set`, {
      // The name can contain up to 64 alphanumeric characters, including letters, numbers, hyphens (-) and underscores (_) only.
      configurationSetName: `${zoneNameWithoutPeriods}-default-configuration-set`,
    })

    new ses.EmailIdentity(this, `Email-${zone.zoneName}`, {
      identity: ses.Identity.publicHostedZone(zone),
      mailFromDomain: this.domainJoin([fromSubdomain, zone.zoneName]),
      configurationSet: defaultConfigurationSet,
    })

    new route53.TxtRecord(this, `Email-${zone.zoneName}-DmarcTxtRecord`, {
      zone,
      recordName: `_dmarc`,
      values: [`v=DMARC1;p=reject;rua=${dmarcRua}`],
    })

    // No templates used currently so no RENDERING_FAILURE destination
    this.createSesSqsDestination({
      name: zoneNameWithoutPeriods,
      configurationSet: defaultConfigurationSet,
      event: ses.EmailSendingEvent.REJECT,
    })
    this.createSesSqsDestination({
      name: zoneNameWithoutPeriods,
      configurationSet: defaultConfigurationSet,
      event: ses.EmailSendingEvent.BOUNCE,
    })
    this.createSesSqsDestination({
      name: zoneNameWithoutPeriods,
      configurationSet: defaultConfigurationSet,
      event: ses.EmailSendingEvent.COMPLAINT,
    })
    this.createSesSqsDestination({
      name: zoneNameWithoutPeriods,
      configurationSet: defaultConfigurationSet,
      event: ses.EmailSendingEvent.DELIVERY_DELAY,
      alarm: false
    })

    const archiveKey = new kms.Key(this, `${zone.zoneName}-mail-archive-key`, {
      alias: `${zoneNameWithoutPeriods}-mail-archive-key`,
      description: `key for the ${zone.zoneName} email archive`,
    })

    archiveKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
      actions: [
        "kms:Decrypt",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
      ],
      resources: ['*'],
    }))

    const archive = new ses.CfnMailManagerArchive(this, `${zone.zoneName}-mail-archive-2`, {
      archiveName: `${zoneNameWithoutPeriods}-mail-archive-2`,
      kmsKeyArn: archiveKey.keyArn,
      retention: {
        retentionPeriod: 'SIX_MONTHS',
      }
    })

    new cr.AwsCustomResource(this, `${zone.zoneName}-mail-archive-attachment`, {
      onUpdate: {
        service: 'sesv2',
        action: 'PutConfigurationSetArchivingOptionsCommand',
        parameters: {
          ConfigurationSetName: defaultConfigurationSet.configurationSetName,
          ArchiveArn: archive.attrArchiveArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString()),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: true,
    })

  }

  createWebHostingInfra(
    zone: route53.HostedZone,
    websiteDomain: string,
    accessLogBucket: s3.Bucket,
  ) {
    const siteBucket = new s3.Bucket(this, `${websiteDomain}-origin-bucket`, {
      bucketName: `${websiteDomain}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED
    })

    const certificate = new acm.Certificate(this, `${websiteDomain}-cert`, {
      domainName: websiteDomain,
      validation: acm.CertificateValidation.fromDns(zone)
    })
    this.createCertAlarm(certificate, websiteDomain)

    const urlRewriteFn = new cloudfront.Function(this, "url-rewrite-fn", {
      comment: "re-writes urls for single page web apps.",
      code: cloudfront.FunctionCode.fromFile({ filePath: 'src/url-rewrite-single-page-apps.js' })
    })

    const distribution = new cloudfront.Distribution(this, `${websiteDomain}-dist`, {
      comment: `website hosting for ${websiteDomain}`,
      domainNames: [websiteDomain],
      certificate: certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      logBucket: accessLogBucket,
      logIncludesCookies: false,

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,

        functionAssociations: [{
          function: urlRewriteFn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },

      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
      ],
    })

    // direct route for website
    new route53.ARecord(this, `${websiteDomain}-to-cf`, {
      zone: zone,
      recordName: websiteDomain,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(distribution)),
    })
  }

  // indirect routes as aliases for website
  //
  // each domain has a s3 redirecting bucket fronted by
  // cloudformation (to provide https redirection) which
  // redirects all requests to the website domain direct route.
  //
  // alternate names also exist to alias various subdomains
  // to their redirecting bucket so that they are also redirected
  // to the website domain.
  createDomainRedirectInfra(
    zone: route53.HostedZone,
    domain: string,
    targetDomain: string,
    accessLogBucket: s3.Bucket,
    redirectingSubdomains: string[] = [],
  ) {
    const alternateNames = redirectingSubdomains?.map(subdomain => this.domainJoin([subdomain, domain]))

    const redirectBucket = new s3.Bucket(this, `${domain}-redirect-bucket`, {
      bucketName: domain,
      websiteRedirect: {
        hostName: targetDomain,
      }
    })

    const redirectCertificate = new acm.Certificate(this, `${domain}-cert`, {
      domainName: domain,
      subjectAlternativeNames: alternateNames,
      validation: acm.CertificateValidation.fromDns(zone)
    })
    this.createCertAlarm(redirectCertificate, domain)

    const redirectDistribution = new cloudfront.Distribution(this, `${domain}-dist`, {
      comment: `http/https redirection for ${domain}`,
      domainNames: [domain, ...alternateNames],
      certificate: redirectCertificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      logBucket: accessLogBucket,
      logIncludesCookies: false,

      defaultBehavior: {
        origin: new origins.S3StaticWebsiteOrigin(redirectBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    })

    // route for domain name to redirect distribution
    new route53.ARecord(this, `${domain}-to-cf`, {
      zone: zone,
      recordName: domain,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
    })

    // route for alternate domain names to redirect distribution
    alternateNames?.forEach(alternateName => {
      new route53.ARecord(this, `${alternateName}-to-cf`, {
        zone: zone,
        recordName: alternateName,
        target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
      })
    })
  }

  createCertAlarm(cert: acm.ICertificate, domain: string) {
    cert.metricDaysToExpiry().createAlarm(this, `${domain}-cert Expiry Alarm`, {
      alarmName: `${domain}-cert Expiry Alarm`,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      threshold: 45, // Automatic rotation happens between 60 and 45 days before expiry
    }).addAlarmAction(...this.alarmActions);
  }

  createSesSqsDestination(props: CreateSesSqsDestinationProps): sns.ITopic {
    const alarm = props.alarm ?? true

    const topic = new sns.Topic(this, `${props.name}-mail-${props.event}-destination-topic`, {
      displayName: `${props.name}-complaint-destination-topic`,
    })

    new ses.ConfigurationSetEventDestination(this, `${props.name}-mail-${props.event}-destination`, {
      configurationSet: props.configurationSet,
      destination: ses.EventDestination.snsTopic(topic),
      events: [props.event],
    })

    const queue = new sqs.Queue(this, `${props.name}-mail-${props.event}-destination-queue`, {
      queueName: `${props.name}-mail-${props.event}-destination-queue`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    })

    topic.addSubscription(new subscriptions.SqsSubscription(queue))

    if (alarm) {
      new cloudwatch.Alarm(this, `${props.name}-mail-${props.event}-alarm`, {
        alarmName: `${queue.queueName} at least one message visible`,
        alarmDescription: `at least one ${props.event} for a ${props.name} email`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'max'
        }),
      }).addAlarmAction(...this.alarmActions)
    }

    return topic
  }

  createSesAlarms() {
    [
      {
        alarmName: 'SES Sends',
        alarmDescription: `high number of sent emails`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 100,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Send',
          period: Duration.days(1),
          statistic: 'sum',
        })
      },
      {
        alarmName: 'SES Rejects',
        alarmDescription: `high number of rejected emails`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Reject',
          period: Duration.minutes(5),
          statistic: 'sum',
        })
      },
      {
        alarmName: 'SES Bounce Rate',
        alarmDescription: `high rate of email bounces`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0.05,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Reputation.BounceRate',
          period: Duration.minutes(5),
          statistic: 'avg',
        })
      },
      {
        alarmName: 'SES Complaint Rate',
        alarmDescription: `high rate of email complaints`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0.001,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SES',
          metricName: 'Reputation.Complaint',
          period: Duration.minutes(5),
          statistic: 'avg',
        })
      },
    ].forEach((props) => {
      new cloudwatch.Alarm(this, `${props.alarmName} Alarm`, props).addAlarmAction(...this.alarmActions);
    });
  }

  createDnssecAlarms(hostedZone: route53.IHostedZone) {
    // DNSSEC metrics emitted 1 per 4 hours per hosted zone
    // https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/monitoring-hosted-zones-with-cloudwatch.html
    const metricEmissionPeriod = Duration.hours(4)
    const alarmAggregationPeriod = Duration.hours(1)
    const evaluationPeriods = Math.ceil(metricEmissionPeriod.toSeconds() / alarmAggregationPeriod.toSeconds());

    const alarmProps: cloudwatch.AlarmProps[] = [
      {
        alarmName: `${hostedZone.zoneName} - DNSSECInternalFailure`,
        alarmDescription: `An object in the hosted zone is in an INTERNAL_FAILURE state`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'DNSSECInternalFailure',
          dimensionsMap: {
            HostedZoneId: hostedZone.hostedZoneId,
          },
          period: alarmAggregationPeriod,
          statistic: 'sum',
        })
      },
      {
        alarmName: `${hostedZone.zoneName} - DNSSECKeySigningKeysNeedingAction`,
        alarmDescription: `DNSSEC key signing keys (KSKs) are in an ACTION_NEEDED state (due to KMS failure).`,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold: 0,
        evaluationPeriods,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'DNSSECKeySigningKeysNeedingAction',
          dimensionsMap: {
            HostedZoneId: hostedZone.hostedZoneId,
          },
          period: alarmAggregationPeriod,
          statistic: 'sum',
        })
      },
    ]

    alarmProps.forEach((prop) => {
      new cloudwatch.Alarm(this, `${prop.alarmName} Alarm`, prop).addAlarmAction(...this.alarmActions);
    });
  }

  domainJoin(parts: (string | undefined)[]) {
    return parts.filter(n => n).join('.')
  }
}
