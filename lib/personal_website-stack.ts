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

export interface DomainRecords {
  readonly MxRecords?: Omit<route53.MxRecordProps, 'zone'>[]
  readonly CnameRecords?: Omit<route53.CnameRecordProps, 'zone'>[]
  readonly TxtRecords?: Omit<route53.TxtRecordProps, 'zone'>[]
}

export interface PersonalWebsiteStackProps extends StackProps {
  readonly websiteSubdomain: string,
  readonly homeSubdomain: string,
  readonly alarmEmail: string,
  readonly primaryDomain: string,
  readonly domainConfigs: {[key: string]: DomainRecords},
}

export class PersonalWebsiteStack extends Stack {
  constructor(scope: Construct, id: string, props: PersonalWebsiteStackProps) {
    super(scope, id, props);

    const websiteDomain = this.domainJoin([props.websiteSubdomain,props.primaryDomain])
    const homeDomain = this.domainJoin([props.homeSubdomain,props.primaryDomain])

    // Logging bucket retains only for limited number of days
    const accessLogBucket = new s3.Bucket(this, `access-logs-bucket`, {
      bucketName: `${id.toLowerCase()}-access-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    })

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'Personal Website Alarms'
    });

    alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));

    const alarmConfigs: cloudwatch.AlarmProps[] = [
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
    ]

    alarmConfigs.forEach((props) => {
      new cloudwatch.Alarm(this, `${props.alarmName} Alarm`, props).addAlarmAction(new cw_actions.SnsAction(alarmTopic));
    });


    Object.entries(props.domainConfigs).map(([domain, records]) => {
      // Creates hosted zones
      let zone = new route53.PublicHostedZone(this, domain, { zoneName: domain })

      // Creates requested DNS records for each domain
      records.MxRecords?.forEach(recordProps =>
        new route53.MxRecord(this, `${this.domainJoin([recordProps.recordName, domain])}-mx`, { zone, ...recordProps })
      )
      records.CnameRecords?.forEach(recordProps =>
        new route53.CnameRecord(this, `${this.domainJoin([recordProps.recordName, domain])}-cname`, { zone, ...recordProps })
      )
      records.TxtRecords?.forEach(recordProps =>
        new route53.TxtRecord(this, `${this.domainJoin([recordProps.recordName, domain])}-txt`, { zone, ...recordProps })
      )


      if (domain == props.primaryDomain) {

        // Website hosting
        this.createWebHostingInfra(zone, websiteDomain, accessLogBucket)

        // Website redirection for domain only as website subdomain is used above 
        this.createDomainRedirectInfra(zone, domain, websiteDomain, accessLogBucket)

        // Home machine email infra
        this.createFromEmailInfra(zone, homeDomain, `mailto:postmaster@${props.primaryDomain}`)

      } else {

        // Website redirection for domain and website subdomain to primary domain website subdomain
        this.createDomainRedirectInfra(zone, domain, websiteDomain, accessLogBucket, [props.websiteSubdomain])

      }
    })
  }

  createFromEmailInfra(
    zone: route53.HostedZone,
    domain: string,
    dmarc_rua: string
  ) {
    const fromDomain = this.domainJoin(['mail', domain])

    const domainIdentity = new ses.EmailIdentity(this, `Email-${domain}`, {
      identity: ses.Identity.domain(domain),
      mailFromDomain: fromDomain,
    })

    domainIdentity.dkimRecords.forEach((dkimRecord, index) =>
      new route53.CnameRecord(this, `${domain}-dkim${index+1}-cname`, {
        zone,
        recordName: `${dkimRecord.name}.`,
        domainName: dkimRecord.value,
      })
    )

    new route53.TxtRecord(this, `${fromDomain}-spf`, {
      zone,
      recordName: `${fromDomain}.`,
      values: [ 'v=spf1 include:amazonses.com ~all' ]
    })

    new route53.TxtRecord(this, `${domain}-dmarc`, {
      zone,
      recordName: `_dmarc.${domain}.`,
      values: [ `v=DMARC1;p=quarantine;rua=${dmarc_rua}` ]
    })

    new route53.MxRecord(this, `${domain}-mx`, {
      zone,
      recordName: `${fromDomain}.`,
      values: [ { priority: 10, hostName: `feedback-smtp.${Stack.of(this).region}.amazonses.com` }]
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

    certificate.metricDaysToExpiry().createAlarm(this, `${websiteDomain}-cert Expiry Alarm`, {
      alarmName: `${websiteDomain}-cert Expiry Alarm`,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      threshold: 45, // Automatic rotation happens between 60 and 45 days before expiry
    });

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
        origin: new origins.S3Origin(siteBucket),
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
          ttl: Duration.minutes(30)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(30)
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

    redirectCertificate.metricDaysToExpiry().createAlarm(this, `${domain}-cert Expiry Alarm`, {
      alarmName: `${domain}-cert Expiry Alarm`,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      threshold: 45, // Automatic rotation happens between 60 and 45 days before expiry
    });

    const redirectDistribution = new cloudfront.Distribution(this, `${domain}-dist`, {
      comment: `http/https redirection for ${domain}`,
      domainNames: [domain, ...alternateNames],
      certificate: redirectCertificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      logBucket: accessLogBucket,
      logIncludesCookies: false,

      defaultBehavior: {
        origin: new origins.S3Origin(redirectBucket),
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

  domainJoin(parts: (string | undefined)[]) {
    return parts.filter(n => n).join('.')
  }
}
