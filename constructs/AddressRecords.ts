import { Construct } from "constructs";
import * as route53 from 'aws-cdk-lib/aws-route53';


export interface AddressRecordsProps {
    zone: route53.IHostedZone,
    domainName: string,
    target: route53.RecordTarget,
    /**
     * IP version configuration for DNS records
     * - 'ipv4-only': Create only A records
     * - 'ipv6-only': Create only AAAA records
     * - 'dual-stack': Create both A and AAAA records
     *
     * @default 'dual-stack'
     */
    ipVersion?: 'ipv4-only' | 'ipv6-only' | 'dual-stack'
}

export class AddressRecords extends Construct {
    constructor(scope: Construct, id: string, props: AddressRecordsProps) {
        super(scope, id);

        const ipVersion = props.ipVersion ?? 'dual-stack'

        if (ipVersion === 'dual-stack' || ipVersion === 'ipv4-only') {
            new route53.ARecord(this, `a`, {
                zone: props.zone,
                recordName: props.domainName,
                target: props.target,
            })
        }

        if (ipVersion === 'dual-stack' || ipVersion === 'ipv6-only') {
            new route53.AaaaRecord(this, `aaaa`, {
                zone: props.zone,
                recordName: props.domainName,
                target: props.target,
            })
        }
    }
}
