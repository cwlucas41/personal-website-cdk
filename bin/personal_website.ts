#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();

const iCloudMxValues = [
  { hostName: 'mx01.mail.icloud.com.', priority: 10 },
  { hostName: 'mx02.mail.icloud.com.', priority: 10 },
]

const iCloudSpfValue = 'v=spf1 include:icloud.com ~all'

new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
  env: {
    region: 'us-east-1'
  },
  websiteSubdomain: 'www',
  primaryDomainConfig: {
    domain: 'chriswlucas.com',
    subdomainMxRecords: {
      '': { values: iCloudMxValues },
    },
    subdomainCnameRecords: {
      'sig1._domainkey': { domainName: 'sig1.dkim.chriswlucas.com.at.icloudmailadmin.com.' },
    },
    subdomainTxtRecords: {
      '': {
        values: [
          iCloudSpfValue,
          'apple-domain=DdleKqlDev7mc5xo',
          'keybase-site-verification=74xSzNnFzF37JGsYtlTgQ5ip70dKbUvAQLpHnaxiEp4',
        ]
      },
    },
  },
  secondaryDomainConfigs: [
    {
      domain: 'chriswlucas.org',
    },
    {
      domain: 'chriswlucas.net',
    }
  ],
});
