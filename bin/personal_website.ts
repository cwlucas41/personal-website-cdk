#!/usr/bin/env node
import { App, Duration } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();

new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
  env: {
    region: 'us-east-1',
  },
  alarmEmail: 'alarm@chriswlucas.com',
  postmasterEmail: 'postmaster@chriswlucas.com',
  apexDomain: 'chriswlucas.com',
  homeSubdomain: 'home',
  websiteSubdomain: 'www',
  records: {
    MxRecords: [
      {
        values: [
          { hostName: 'mx01.mail.icloud.com.', priority: 10 },
          { hostName: 'mx02.mail.icloud.com.', priority: 10 },
        ],
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
          'v=spf1 include:icloud.com ~all',
          'apple-domain=DdleKqlDev7mc5xo',
          'keybase-site-verification=74xSzNnFzF37JGsYtlTgQ5ip70dKbUvAQLpHnaxiEp4',
          'google-site-verification=-y6CXohbao4xigEBlFXanLydR90TZ1mO5gFMBzVtBsY',
        ],
        ttl: Duration.hours(1),
      },
    ],
  },
});
