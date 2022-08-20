#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();

const gmailMxValues = [
  { hostName: 'ASPMX.L.GOOGLE.COM.', priority: 1 },
  { hostName: 'ALT1.ASPMX.L.GOOGLE.COM.', priority: 5 },
  { hostName: 'ALT2.ASPMX.L.GOOGLE.COM.', priority: 5 },
  { hostName: 'ALT3.ASPMX.L.GOOGLE.COM.', priority: 10 },
  { hostName: 'ALT4.ASPMX.L.GOOGLE.COM.', priority: 10 }
]

const gmailSpfValue = 'v=spf1 include:_spf.google.com ~all'

new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
  env: {
    region: 'us-east-1'
  },
  websiteSubdomain: 'www',
  primaryDomainConfig: {
    domain: 'chriswlucas.com',
    subdomainMxRecords: {
      '': { values: gmailMxValues },
    },
    subdomainTxtRecords: {
      '': {
        values: [
          gmailSpfValue,
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
