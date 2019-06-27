import cdk = require('@aws-cdk/core');
import acm = require('@aws-cdk/aws-certificatemanager');
import cloudfront = require('@aws-cdk/aws-cloudfront');
import s3 = require('@aws-cdk/aws-s3');
import route53 = require('@aws-cdk/aws-route53');
import targets = require('@aws-cdk/aws-route53-targets');
import { AddressRecordTarget } from '@aws-cdk/aws-route53';
import { PriceClass } from '@aws-cdk/aws-cloudfront';


export class PersonalWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const primaryDomain = "chriswlucas.com"
    const secondaryDomains = ["chriswlucas.org", "chriswlucas.net"]

    const allDomains = [primaryDomain, ...secondaryDomains]

    // Hosting

    const siteBucket = new s3.Bucket(this, `${primaryDomain}-origin-bucket`, {
      bucketName: `${primaryDomain}-origin`,
      publicReadAccess: true,
    })

    const certificate = new acm.Certificate(this, `${primaryDomain}-certificate`, {
      domainName: primaryDomain,
      subjectAlternativeNames: secondaryDomains,
    })

    const distribution = new cloudfront.CloudFrontWebDistribution(this, `${primaryDomain}-distribution`, {
      aliasConfiguration: {
        acmCertRef: certificate.certificateArn,
        names: allDomains,
        sslMethod: cloudfront.SSLMethod.SNI,
      },
      originConfigs: [
        {
          s3OriginSource: { s3BucketSource: siteBucket },
          behaviors: [
            { isDefaultBehavior: true }
          ]
        }
      ],
      priceClass: PriceClass.PRICE_CLASS_100
    })

    // DNS

    const zones = allDomains
      .reduce(
        (object, domain) => {
          object[domain] = new route53.PublicHostedZone(this, domain, {
            zoneName: domain
          });
          return object
        },
        {} as { [index: string]: route53.PublicHostedZone },
      )

    allDomains.forEach(domain => {

      new route53.ARecord(this, `${domain}-a-apex-cf`, {
        zone: zones[domain],
        target: AddressRecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      })

      new route53.ARecord(this, `${domain}-a-www-cf`, {
        zone: zones[domain],
        recordName: `www.${domain}`,
        target: AddressRecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      })

      new route53.MxRecord(this, `${domain}-mx-gmail`, {
        zone: zones[domain],
        values: [
          { hostName: 'ASPMX.L.GOOGLE.COM.', priority: 1 },
          { hostName: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT2.ASPMX.L.GOOGLE.COM.', priority: 5 },
          { hostName: 'ALT3.ASPMX.L.GOOGLE.COM.', priority: 10 },
          { hostName: 'ALT4.ASPMX.L.GOOGLE.COM.', priority: 10 },
        ]
      })

      new route53.TxtRecord(this, `${domain}-txt-spf`, {
        zone: zones[domain],
        values: ['v=spf1 include:_spf.google.com ~all']
      })
    })
  }
}
