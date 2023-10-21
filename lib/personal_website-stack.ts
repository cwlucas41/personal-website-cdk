import { Construct } from 'constructs';
import { Stack, StackProps, Duration } from 'aws-cdk-lib';

import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_ses as ses } from 'aws-cdk-lib';
import { aws_route53 as route53 } from 'aws-cdk-lib';
import { aws_route53_targets as route53_targets } from 'aws-cdk-lib';
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib';
import { aws_cloudfront_origins as origins } from 'aws-cdk-lib';
import { aws_certificatemanager as acm } from 'aws-cdk-lib';
import { CnameRecordProps, MxRecordProps, TxtRecordProps } from 'aws-cdk-lib/aws-route53';

interface DomainConfig {
  readonly domain: string
  readonly subdomainMxRecords?: {[key: string]: Omit<MxRecordProps, 'zone' | 'recordName'>}
  readonly subdomainCnameRecords?: {[key: string]: Omit<CnameRecordProps, 'zone' | 'recordName'>}
  readonly subdomainTxtRecords?: {[key: string]: Omit<TxtRecordProps, 'zone' | 'recordName'>}
}

export interface PersonalWebsiteStackProps extends StackProps {
  readonly websiteSubdomain: string,
  readonly homeSubdomain: string,
  readonly primaryDomainConfig: DomainConfig,
  readonly secondaryDomainConfigs: DomainConfig[]
}

export class PersonalWebsiteStack extends Stack {
  constructor(scope: Construct, id: string, props: PersonalWebsiteStackProps) {
    super(scope, id, props);

    interface DomainProps {
      readonly zone: route53.HostedZone,
      readonly mxRecordsProps?: MxRecordProps[]
      readonly cnameRecordsProps?: CnameRecordProps[]
      readonly txtRecordsProps?: TxtRecordProps[]
    }

    const domainConfigMap: Map<string, DomainProps> = new Map(
      [props.primaryDomainConfig, ...props.secondaryDomainConfigs]
        .map(config => {
          // Creates hosted zones
          let zone = new route53.PublicHostedZone(this, config.domain, { zoneName: config.domain })

          function getRecordName(subdomain: string): string {
            return subdomain ? `${subdomain}.${config.domain}` : config.domain
          }

          let domainProps: DomainProps = {
            zone,

            // Augment RecordData with missing zone and record Name to make RecordProps
            mxRecordsProps: Object.entries(config.subdomainMxRecords || {}).map(
              ([subdomain, recordData]) => ({ zone, recordName: getRecordName(subdomain), ...recordData })),

            cnameRecordsProps: Object.entries(config.subdomainCnameRecords || {}).map(
              ([subdomain, recordData]) => ({ zone, recordName: getRecordName(subdomain), ...recordData })),

            txtRecordsProps: Object.entries(config.subdomainTxtRecords || {}).map(
              ([subdomain, recordData]) => ({ zone, recordName: getRecordName(subdomain), ...recordData })),
          }

          return [config.domain, domainProps]
        })
    )

    // DNS RECORD SECTION
    // Creates requested DNS records for each domain
    domainConfigMap.forEach((config, apexDomain) => {
      config.mxRecordsProps?.forEach(recordProps =>
        new route53.MxRecord(this, `${recordProps.recordName || apexDomain}-mx`, recordProps)
      )
      config.cnameRecordsProps?.forEach(recordProps =>
        new route53.CnameRecord(this, `${recordProps.recordName || apexDomain}-cname`, recordProps)
      )
      config.txtRecordsProps?.forEach(recordProps =>
        new route53.TxtRecord(this, `${recordProps.recordName || apexDomain}-txt`, recordProps)
      )
    })

    // HOME EMAIL SECTION
    const homeDomain = `${props.homeSubdomain}.${props.primaryDomainConfig.domain}`
    // const homeZone = new route53.PublicHostedZone(this, homeDomain, { zoneName: homeDomain })
    const fromIdentity = new ses.EmailIdentity(this, `Identity-${homeDomain}`, {
      identity: ses.Identity.publicHostedZone(domainConfigMap.get(props.primaryDomainConfig.domain)!.zone),
      mailFromDomain: homeDomain,
    })
    const toIdentity = new ses.EmailIdentity(this, 'Identity-chris@chriswlucas.com', {
      identity: ses.Identity.email('chris@chriswlucas.com')
    })

    // WEBSITE SECTION
    const websiteDomain = `${props.websiteSubdomain}.${props.primaryDomainConfig.domain}`
    const websiteZone = domainConfigMap.get(props.primaryDomainConfig.domain)!.zone

    // Logging bucket retains only for limited number of days
    const accessLogBucket = new s3.Bucket(this, `access-logs-bucket`, {
      bucketName: `${id.toLowerCase()}-access-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    })

    // Site hosting
    this.createWebHostingInfra(websiteDomain, websiteZone, accessLogBucket)

    // Other domain website redirection
    domainConfigMap.forEach((config, apexDomain) => {
      // primary domain doesn't need website subdomain redirection
      const redirectingSubdomains = apexDomain != props.primaryDomainConfig.domain ? [props.websiteSubdomain] : []

      // Configure necessary redirection
      this.createDomainRedirectInfra(apexDomain, redirectingSubdomains, websiteDomain, config.zone, accessLogBucket)
    })
  }

  createWebHostingInfra(
    websiteDomain: string,
    zone: route53.HostedZone,
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
    apexDomain: string,
    redirectingSubdomains: string[],
    targetDomain: string,
    zone: route53.HostedZone,
    accessLogBucket: s3.Bucket,
  ) {
    const alternateNames = redirectingSubdomains.map(subdomain => `${subdomain}.${apexDomain}`)

    const redirectBucket = new s3.Bucket(this, `${apexDomain}-redirect-bucket`, {
      bucketName: apexDomain,
      websiteRedirect: {
        hostName: targetDomain,
      }
    })

    const redirectCertificate = new acm.Certificate(this, `${apexDomain}-cert`, {
      domainName: apexDomain,
      subjectAlternativeNames: alternateNames,
      validation: acm.CertificateValidation.fromDns(zone)
    })

    const redirectDistribution = new cloudfront.Distribution(this, `${apexDomain}-dist`, {
      comment: `http/https redirection for ${apexDomain}`,
      domainNames: [apexDomain, ...alternateNames],
      certificate: redirectCertificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      logBucket: accessLogBucket,
      logIncludesCookies: false,

      defaultBehavior: {
        origin: new origins.S3Origin(redirectBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    })

    // route for apex domain name to redirect distribution
    new route53.ARecord(this, `${apexDomain}-to-cf`, {
      zone: zone,
      recordName: apexDomain,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
    })

    // route for alternate domain names to redirect distribution
    alternateNames.forEach(alternateName => {
      new route53.ARecord(this, `${alternateName}-to-cf`, {
        zone: zone,
        recordName: alternateName,
        target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
      })
    })
  }
}
