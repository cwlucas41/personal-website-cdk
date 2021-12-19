import cdk = require('@aws-cdk/core');
import acm = require('@aws-cdk/aws-certificatemanager');
import cloudfront = require('@aws-cdk/aws-cloudfront');
import s3 = require('@aws-cdk/aws-s3');
import route53 = require('@aws-cdk/aws-route53');
import targets = require('@aws-cdk/aws-route53-targets');
import { RecordTarget } from '@aws-cdk/aws-route53';
import { PriceClass } from '@aws-cdk/aws-cloudfront';

interface ZoneMap { [index: string]: route53.PublicHostedZone }

export class PersonalWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const primaryDomain = "chriswlucas.com"
    const secondaryDomains = ["chriswlucas.org", "chriswlucas.net"]

    const apexDomains = [primaryDomain, ...secondaryDomains]

    // Hosted Zones
    const zoneMap = apexDomains
      .reduce(
        (object, domain) => {

          object[domain] = new route53.PublicHostedZone(this, domain, {
            zoneName: domain
          });

          return object
        },
        {} as ZoneMap,
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

    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI');

    const certificate = new acm.Certificate(this, `${primaryDomain}-certificate`, {
      domainName: primaryDomain,
      subjectAlternativeNames: websiteDomains.filter(domain => domain !== primaryDomain),
    })

    const distribution = new cloudfront.CloudFrontWebDistribution(this, `${primaryDomain}-distribution`, {
      viewerCertificate: cloudfront.ViewerCertificate.fromAcmCertificate(
        certificate, 
        {
          aliases: websiteDomains,
          sslMethod: cloudfront.SSLMethod.SNI,
        },
      ),
      originConfigs: [
        {
          s3OriginSource: { 
            s3BucketSource: siteBucket,
            originAccessIdentity: oai,
          },
          behaviors: [
            { isDefaultBehavior: true }
          ]
        }
      ],
      priceClass: PriceClass.PRICE_CLASS_100
    })

    // www subdomain redirection
    websiteDomains.forEach(domain => {
      const apexDomain = apexDomains.filter(apexDomain => domain.includes(apexDomain))[0]

      new route53.ARecord(this, `${domain}-cf-aliases`, {
        zone: zoneMap[apexDomain],
        recordName: domain,
        target: RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      })
    })

    // Email
    apexDomains.forEach(domain => {
      new route53.MxRecord(this, `${domain}-mx-gmail`, {
        zone: zoneMap[domain],
        values: [
          { hostName: 'ASPMX.L.GOOGLE.COM.', priority: 1 },
          { hostName: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT2.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT3.ASPMX.L.GOOGLE.COM.', priority: 10 },
          { hostName: 'ALT4.ASPMX.L.GOOGLE.COM.', priority: 10 },
        ]
      })

      new route53.TxtRecord(this, `${domain}-txt-spf`, {
        zone: zoneMap[domain],
        values: ['v=spf1 include:_spf.google.com ~all']
      })
    })
  }
}
