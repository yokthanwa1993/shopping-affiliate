const test = require('node:test');
const assert = require('node:assert/strict');

const { pickExistingCampaignForName } = require('./campaign-utils');

test('pickExistingCampaignForName reuses exact same-name matching-objective non-deleted campaign', () => {
  const campaigns = [
    { id: 'old-objective', name: '16MAY26FBSPCAD', status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' },
    { id: 'wrong-name', name: '16MAY26FBSPCAD copy', status: 'ACTIVE', objective: 'LINK_CLICKS' },
    { id: 'deleted', name: '16MAY26FBSPCAD', status: 'DELETED', objective: 'LINK_CLICKS' },
    { id: 'reuse-me', name: '16MAY26FBSPCAD', status: 'PAUSED', objective: 'LINK_CLICKS' },
  ];

  assert.equal(pickExistingCampaignForName(campaigns, '16MAY26FBSPCAD', 'LINK_CLICKS')?.id, 'reuse-me');
});

test('pickExistingCampaignForName returns null when no exact reusable campaign exists', () => {
  const campaigns = [
    { id: 'contains-only', name: '16MAY26FBSPCAD_1', status: 'ACTIVE', objective: 'LINK_CLICKS' },
    { id: 'deleted', name: '16MAY26FBSPCAD', status: 'DELETED', objective: 'LINK_CLICKS' },
  ];

  assert.equal(pickExistingCampaignForName(campaigns, '16MAY26FBSPCAD', 'LINK_CLICKS'), null);
});
