function pickExistingCampaignForName(campaigns, campaignName, templateObjective) {
  const name = String(campaignName || '').trim();
  const objective = String(templateObjective || '').trim();
  if (!name || !objective || !Array.isArray(campaigns)) return null;

  return campaigns.find((campaign) => {
    return String(campaign?.name || '').trim() === name
      && String(campaign?.objective || '').trim() === objective
      && String(campaign?.status || '').trim() !== 'DELETED';
  }) || null;
}

module.exports = { pickExistingCampaignForName };
