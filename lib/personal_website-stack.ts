import { Construct } from 'constructs';
import { Stack, StackProps, Duration } from 'aws-cdk-lib';

import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_route53 as route53 } from 'aws-cdk-lib';
import { aws_route53_targets as route53_targets } from 'aws-cdk-lib';
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib';
import { aws_cloudfront_origins as origins } from 'aws-cdk-lib';
import { aws_certificatemanager as acm } from 'aws-cdk-lib';

interface DomainZoneMap { [index: string]: route53.PublicHostedZone }

export class PersonalWebsiteStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);


    const primaryDomain = "chriswlucas.com"

    const websiteSubdomain = 'www'
    const websiteDomain = `${websiteSubdomain}.${primaryDomain}`

    const apexDomains = [primaryDomain, "chriswlucas.org", "chriswlucas.net"]

    const verificationRecordsMap = new Map([
      [ primaryDomain, [ 'keybase-site-verification=74xSzNnFzF37JGsYtlTgQ5ip70dKbUvAQLpHnaxiEp4' ] ],
    ])

    // Hosted Zones
    const apexDomadinZoneMap = apexDomains
      .reduce(
        (map, apexDomain) => {

          map[apexDomain] = new route53.PublicHostedZone(this, apexDomain, {
            zoneName: apexDomain
          });

          return map
        },
        {} as DomainZoneMap,
      )

    // Website hosting
    const siteBucket = new s3.Bucket(this, `${primaryDomain}-origin-bucket`, {
      bucketName: `${primaryDomain}-origin`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED
    })

    const accessLogBucket = new s3.Bucket(this, `${primaryDomain}-access-logs-bucket`, {
      bucketName: `${primaryDomain}-access-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [ { expiration: Duration.days(90) } ],
    })

    const certificate = new acm.Certificate(this, `${websiteDomain}-cert`, {
      domainName: websiteDomain,
      validation: acm.CertificateValidation.fromDns(apexDomadinZoneMap[primaryDomain])
    })

    const urlRewriteFn = new cloudfront.Function(this, "url-rewrite-fn", {
      comment: "re-writes urls for single page web apps.",
      code: cloudfront.FunctionCode.fromFile({filePath: 'src/url-rewrite-single-page-apps.js'})
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
      zone: apexDomadinZoneMap[primaryDomain],
      recordName: websiteDomain,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(distribution)),
    })

    // indirect routes as aliases for website
    //
    // each domain has a s3 redirecting bucket fronted by
    // cloudformation (to provide https redirection) which
    // redirects all requests to the website domain direct route.
    //
    // alternate names also exist to alias various subdomains
    // to their redirecting bucket so that they are also redirected
    // to the website domain.
    apexDomains.forEach(apexDomain => {

      const alternateNames = [websiteSubdomain]
        .map(subdomain => `${subdomain}.${apexDomain}`)
        // omit website domain since it already has a direct route
        .filter(alternateName => alternateName != websiteDomain)

      const redirectBucket = new s3.Bucket(this, `${apexDomain}-redirect-bucket`, {
        bucketName: apexDomain,
        websiteRedirect: {
          hostName: websiteDomain,
        }
      })

      const redirectCertificate = new acm.Certificate(this, `${apexDomain}-cert`, {
        domainName: apexDomain,
        subjectAlternativeNames: alternateNames,
        validation: acm.CertificateValidation.fromDns(apexDomadinZoneMap[apexDomain])
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
        zone: apexDomadinZoneMap[apexDomain],
        recordName: apexDomain,
        target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
      })

      // route for alternate domain names to redirect distribution
      alternateNames.forEach(alternateName => {
        new route53.ARecord(this, `${alternateName}-to-cf`, {
          zone: apexDomadinZoneMap[apexDomain],
          recordName: alternateName,
          target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(redirectDistribution)),
        })
      })

    })

    // Other DNS records
    apexDomains.forEach(apexDomain => {

      // Email
      new route53.MxRecord(this, `${apexDomain}-mx-gmail`, {
        zone: apexDomadinZoneMap[apexDomain],
        values: [
          { hostName: 'ASPMX.L.GOOGLE.COM.', priority: 1 },
          { hostName: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT2.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT3.ASPMX.L.GOOGLE.COM.', priority: 10 },
          { hostName: 'ALT4.ASPMX.L.GOOGLE.COM.', priority: 10 },
        ]
      })

      // TXT: configuration & verification
      new route53.TxtRecord(this, `${apexDomain}-txt-spf`, {
        zone: apexDomadinZoneMap[apexDomain],
        values: [
          'v=spf1 include:_spf.google.com ~all',
          ...verificationRecordsMap.get(apexDomain) ?? []
        ]
      })

    })
  }
}
