#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new App();
new PersonalWebsiteStack(app, 'PersonalWebsiteStack', {
    env: {
        region: 'us-east-1'
    }
});
