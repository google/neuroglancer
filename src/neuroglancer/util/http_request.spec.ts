import {parseSpecialUrl} from 'neuroglancer/util/http_request';

describe('Prasing Special URLs', () => {
  let ezParseSpecialUrl = (url: string) => parseSpecialUrl(url)[0][0];

  it('Parse Normal URL', () => {
    expect(ezParseSpecialUrl('http://example.com/arg1/arg2/arg3/')).toBe('http://example.com/arg1/arg2/arg3/');
    expect(ezParseSpecialUrl('https://example.com/arg1/arg2/arg3/')).toBe('https://example.com/arg1/arg2/arg3/');
    expect(ezParseSpecialUrl('ftp://example.com/arg1/arg2/arg3/')).toBe('ftp://example.com/arg1/arg2/arg3/');
  });

  it('Parse Google Storage Url (gs://)', () => {
    let result = parseSpecialUrl('gs://bucket/dataset/layer/')
    
    expect(result[0][0]).toBe('https://storage.googleapis.com/bucket');
    expect(result[1]).toBe('/dataset/layer/');
  });

  it('Parse Glance Url (glance://)', () => {
    expect(ezParseSpecialUrl('glance://dataset/layer/')).toBe('https://localhost/blob/dataset/layer/');
  });
});
