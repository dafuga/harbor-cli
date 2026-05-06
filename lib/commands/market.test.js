import assert from 'node:assert/strict';
import test from 'node:test';
import { bestOpportunity, buildOpportunities, } from '@harbor/opportunities/market';
import { buildAgentOpportunityReportFromSnapshot, buildMarketActionData } from './market.js';
function serviceType(id, name, budget) {
    return {
        id,
        service_name: name,
        enabled: 1,
        reward_weight: 1,
        epoch_budget: budget,
        base_provider_reward: '1.0000 SYS',
        provider_fail_penalty: '0.0000 SYS',
        oracle_agree_reward: '0.0000 SYS',
        oracle_disagree_penalty: '0.0000 SYS',
        oracle_miss_penalty: '0.0000 SYS',
        min_provider_stake: '0.0000 SYS',
        min_oracle_stake: '0.0000 SYS',
        min_oracle_reports: 2,
        min_check_window_sec: 1,
    };
}
function service(id, serviceTypeId) {
    return {
        id,
        provider: `agent${id}`,
        service_type: serviceTypeId,
        segment_kind: 1,
        range_start: 0,
        range_end: 1,
        capacity_bytes: 1,
        active: 1,
        endpoint: 'http://127.0.0.1',
        metadata: '{}',
    };
}
function opportunityText(opportunities, name, key) {
    const opportunity = opportunities.find((item) => item.name === name);
    assert.ok(opportunity, `${name} opportunity should exist`);
    return String(opportunity[key] ?? '');
}
test('bestOpportunity prefers the best reward, then deeper budget', () => {
    const opportunities = buildOpportunities([
        serviceType(1, 'chainapi', '4.0000 SYS'),
        serviceType(2, 'storage', '10.0000 SYS'),
    ], [service(1, 2), service(2, 2)]);
    assert.equal(bestOpportunity(opportunities)?.name, 'storage');
});
test('bestOpportunity shifts when a service gets crowded', () => {
    const services = Array.from({ length: 12 }, (_, index) => service(index + 1, 2));
    const opportunities = buildOpportunities([
        serviceType(1, 'chainapi', '4.0000 SYS'),
        serviceType(2, 'storage', '10.0000 SYS'),
    ], services);
    assert.equal(bestOpportunity(opportunities)?.name, 'chainapi');
});
test('opportunities describe narrow service duties', () => {
    const opportunities = buildOpportunities([
        serviceType(8, 'bp', '4.0000 SYS'),
        serviceType(2, 'traceapi', '4.0000 SYS'),
        serviceType(3, 'storage', '4.0000 SYS'),
        serviceType(4, 'histcore', '4.0000 SYS'),
        serviceType(9, 'histactions', '4.0000 SYS'),
        serviceType(10, 'histtx', '4.0000 SYS'),
        serviceType(11, 'histapi', '4.0000 SYS'),
        serviceType(6, 'p2pseed', '4.0000 SYS'),
        serviceType(13, 'verifier', '4.0000 SYS'),
    ], []);
    const checks = [
        ['bp', 'duties', /Produce and validate blocks only/],
        ['bp', 'mustNot', /Do not serve chain API/],
        ['traceapi', 'duties', /traces only/],
        ['traceapi', 'mustNot', /Do not serve chain API/],
        ['storage', 'duties', /Store declared Harbor artifacts/],
        ['storage', 'oracleChecks', /sampled object hashes/],
        ['histcore', 'duties', /declared block range/],
        ['histactions', 'duties', /account\/action history/],
        ['histtx', 'duties', /transaction-id lookups/],
        ['histapi', 'mustNot', /separate range registration/],
        ['p2pseed', 'duties', /relay blocks\/transactions/],
        ['verifier', 'duties', /registered Harbor agents/],
        ['verifier', 'oracleChecks', /storage replica audits/],
    ];
    for (const [name, key, pattern] of checks) {
        assert.match(opportunityText(opportunities, name, key), pattern);
    }
});
test('referral market actions serialize expected payloads', () => {
    assert.deepEqual(buildMarketActionData([
        ['enabled', 'boolean'],
        ['first_level_bps', 'number'],
        ['decay_bps', 'number'],
        ['max_total_bps', 'number'],
    ], ['true', '500', '5000', '1000']), {
        enabled: true,
        first_level_bps: 500,
        decay_bps: 5000,
        max_total_bps: 1000,
    });
    assert.deepEqual(buildMarketActionData(['account', 'referrer'], ['agent1111111', 'mentor11111']), {
        account: 'agent1111111',
        referrer: 'mentor11111',
    });
});
test('agent unable markers remove opportunities from best selection', () => {
    const report = buildAgentOpportunityReportFromSnapshot({
        types: [
            serviceType(14, 'router', '10.0000 SYS'),
            serviceType(1, 'chainapi', '4.0000 SYS'),
        ],
        services: [],
        state: { reward_pool: '10.0000 SYS' },
    }, [{
            service_type: 14,
            service_name: 'router',
            reason: 'requires a domain',
            metadata: '{"missing":"domain"}',
            updated_at: '2026-05-05T00:00:00',
        }], 'agent1111111');
    assert.equal(report.best?.name, 'chainapi');
    const router = report.opportunities.find((opportunity) => opportunity.name === 'router');
    assert.equal(router?.status, 'unable');
    assert.equal(router?.unableReason, 'requires a domain');
});
