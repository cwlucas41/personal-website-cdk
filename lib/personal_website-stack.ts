import cdk = require('@aws-cdk/core');
import route53 = require('@aws-cdk/aws-route53');
import { AddressRecordTarget } from '@aws-cdk/aws-route53';


export class PersonalWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const primaryDomain = "chriswlucas.com"
    const secondaryDomains = ["chriswlucas.org", "chriswlucas.net"]

    const allDomains = [primaryDomain, ...secondaryDomains]

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

      new route53.ARecord(this, `${domain}-a-nfs`, {
        zone: zones[domain],
        target: AddressRecordTarget.fromIpAddresses('208.94.118.206')
      })
  
      new route53.CnameRecord(this, `${domain}-cname-nfs`, {
        zone: zones[domain],
        recordName: `www.${domain}`,
        domainName: 'cwlhome.nfshost.com.',
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
