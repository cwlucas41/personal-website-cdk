# personal-website-cdk

Contains the Infrastructure to host [www.chriswlucas.com](https://www.chriswlucas.com). Website content is hosted in [personal-website-content](https://github.com/cwlucas41/personal-website-content) and licensed separately from this infrastructure.


## TODO
* separate into multiple stacks, possibly nested
* CD pipeline to deploy website content
* backup origin bucket in a different region - mostly for style

## Infrastructure

### Features
* CloudFront hosting of website content in an S3 bucket
* Access logs for website with automatic deletion
* Alias domains and subdomains that get redirected to the website domain automatically
* Certificates with ACM that automatically renew
* MX records for Gmail
* TXT record for Gmail config and various verifications

### Web hosting and redirects diagram
![](doc/website-infrastructure.png)


## URLs expected to work
* http://chriswlucas.com
* http://chriswlucas.org
* http://chriswlucas.net
* http://www.chriswlucas.com
* http://www.chriswlucas.org
* http://www.chriswlucas.net
* https://chriswlucas.com
* https://chriswlucas.org
* https://chriswlucas.net
* https://www.chriswlucas.com
* https://www.chriswlucas.org
* https://www.chriswlucas.net