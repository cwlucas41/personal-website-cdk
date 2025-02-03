#!/usr/bin/env node
import { App, Duration } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();

const iCloudSpfValue = 'v=spf1 include:icloud.com ~all'
const iCloudMxValues = [
  { hostName: 'mx01.mail.icloud.com.', priority: 10 },
  { hostName: 'mx02.mail.icloud.com.', priority: 10 },
]

new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
  env: {
    region: 'us-east-1'
  },
  websiteSubdomain: 'www',
  homeSubdomain: 'home',
  alarmEmail: 'alarm@chriswlucas.com',
  postmasterEmail: 'postmaster@chriswlucas.com',
  primaryDomain: 'chriswlucas.com',
  domainConfigs: {
    'chriswlucas.com': {
      MxRecords: [
        {
          values: iCloudMxValues,
          ttl: Duration.days(1),
        }
      ],
      CnameRecords: [
        {
          recordName: 'sig1._domainkey',
          domainName: 'sig1.dkim.chriswlucas.com.at.icloudmailadmin.com.',
          ttl: Duration.days(1),
        },
      ],
      TxtRecords: [
        {
          values: [
            iCloudSpfValue,
            'apple-domain=DdleKqlDev7mc5xo',
            'keybase-site-verification=74xSzNnFzF37JGsYtlTgQ5ip70dKbUvAQLpHnaxiEp4',
            'google-site-verification=-y6CXohbao4xigEBlFXanLydR90TZ1mO5gFMBzVtBsY',
          ],
          ttl: Duration.hours(1),
        },
      ],
    },
    'chriswlucas.org': {
      TxtRecords: [
        {
          values: ['google-site-verification=eum67Zs46nv_NLwhZ0PV6aPdTIoJIv2cjnrd3t6VO5o'],
          ttl: Duration.hours(1),
        },
      ],
    },
    'chriswlucas.net': {
      TxtRecords: [
        {
          values: ['google-site-verification=oenFzY8fj0pDqA1DebjDT38z49YkQjccTzaXAXtN1A8'],
          ttl: Duration.hours(1),
        },
      ],
    },
  },
});
