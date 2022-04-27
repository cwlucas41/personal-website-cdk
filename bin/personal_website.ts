#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();
new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
  env: {
    region: 'us-east-1'
  },
  websiteSubdomain: 'www',
  primaryDomainConfig: {
    domain: 'chriswlucas.com',
    additionalTxtRecords: ['keybase-site-verification=74xSzNnFzF37JGsYtlTgQ5ip70dKbUvAQLpHnaxiEp4']
  },
  secondaryDomainConfigs: [
    {
      domain: 'chriswlucas.org'
    },
    {
      domain: 'chriswlucas.net'
    }
  ],
});
