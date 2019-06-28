#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { PersonalWebsiteStack } from '../lib/personal_website-stack';

const app = new cdk.App();
new PersonalWebsiteStack(app, 'PersonalWebsiteStack');
