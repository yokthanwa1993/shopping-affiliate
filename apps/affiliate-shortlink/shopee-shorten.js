async function(productUrl, subIds) {
  var GQL_ENDPOINT = 'https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink';

  var csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);

  var headers = {
    'Content-Type': 'application/json',
    'affiliate-program-type': '1'
  };
  if (csrfMatch) headers['csrf-token'] = csrfMatch[1];

  var linkParam = { originalLink: productUrl };
  if (subIds && Array.isArray(subIds) && subIds.length > 0) {
    linkParam.subIds = subIds;
  }

  var resp = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: headers,
    credentials: 'include',
    body: JSON.stringify({
      operationName: 'batchGetCustomLink',
      variables: {
        linkParams: [linkParam],
        sourceCaller: 'CUSTOM_LINK_CALLER'
      },
      query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }'
    })
  });

  var json = await resp.json();
  var results = json && json.data && json.data.batchCustomLink;
  if (!results || !results.length) {
    throw new Error('No results: ' + JSON.stringify(json).substring(0, 200));
  }

  var r = results[0];
  if (r.failCode && r.failCode !== 0) {
    throw new Error('failCode: ' + r.failCode);
  }

  return { shortLink: r.shortLink || '', longLink: r.longLink || '', originalLink: productUrl };
}
