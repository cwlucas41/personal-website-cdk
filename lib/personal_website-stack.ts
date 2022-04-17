import { Construct } from 'constructs';
import { Stack, StackProps, Duration } from 'aws-cdk-lib';

import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_route53 as route53 } from 'aws-cdk-lib';
import { aws_route53_targets as route53_targets } from 'aws-cdk-lib';
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib';
import { aws_cloudfront_origins as origins } from 'aws-cdk-lib';
import { aws_certificatemanager as acm } from 'aws-cdk-lib';

import { AllowedMethods, CachedMethods, SecurityPolicyProtocol, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';

interface DomainZoneMap { [index: string]: route53.PublicHostedZone }

export class PersonalWebsiteStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const primaryDomain = "chriswlucas.com"
    const secondaryDomains = ["chriswlucas.org", "chriswlucas.net"]

    const apexDomains = [primaryDomain, ...secondaryDomains]

    // Hosted Zones
    const domainZoneMap = apexDomains
      .reduce(
        (map, domain) => {

          map[domain] = new route53.PublicHostedZone(this, domain, {
            zoneName: domain
          });

          return map
        },
        {} as DomainZoneMap,
      )

    // Website
    const websiteDomains = apexDomains
      .map(domain => [domain, `www.${domain}`])
      .reduce((x,y) => x.concat(y), [])

    const siteBucket = new s3.Bucket(this, `${primaryDomain}-origin-bucket`, {
      bucketName: `${primaryDomain}-origin`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED
    })

    // Access logs
    const accessLogBucket = new s3.Bucket(this, `${primaryDomain}-access-logs-bucket`, {
      bucketName: `${primaryDomain}-access-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [ { expiration: Duration.days(90) } ],
    })

    // Certificate
    const certificate = new acm.Certificate(this, `${primaryDomain}-certificate`, {
      domainName: primaryDomain,
      subjectAlternativeNames: websiteDomains.filter(domain => domain !== primaryDomain),
    })

    // Distribution
    const distribution = new cloudfront.Distribution(this, `${primaryDomain}-distribution`, {
      enabled: true,
      certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames: websiteDomains,
      defaultBehavior: {
        origin: new origins.S3Origin(siteBucket),
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        compress: true,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },

      defaultRootObject: "index.html",
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,

      // logging
      logBucket: accessLogBucket,
      logIncludesCookies: false,
    })

    // www subdomain redirection
    websiteDomains.forEach(domain => {
      const apexDomain = apexDomains.filter(apexDomain => domain.includes(apexDomain))[0]

      new route53.ARecord(this, `${domain}-cf-aliases`, {
        zone: domainZoneMap[apexDomain],
        recordName: domain,
        target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(distribution)),
      })
    })

    // Email
    apexDomains.forEach(domain => {
      new route53.MxRecord(this, `${domain}-mx-gmail`, {
        zone: domainZoneMap[domain],
        values: [
          { hostName: 'ASPMX.L.GOOGLE.COM.', priority: 1 },
          { hostName: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT2.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT3.ASPMX.L.GOOGLE.COM.', priority: 10 },
          { hostName: 'ALT4.ASPMX.L.GOOGLE.COM.', priority: 10 },
        ]
      })

      new route53.TxtRecord(this, `${domain}-txt-spf`, {
        zone: domainZoneMap[domain],
        values: ['v=spf1 include:_spf.google.com ~all']
      })
    })
  }
}
