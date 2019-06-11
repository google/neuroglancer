import {parseSpecialUrl} from 'neuroglancer/util/http_request';

describe('Parsing Special URLs', () => {
  const ezParseSpecialUrl = (url: string) => parseSpecialUrl(url);

  it('Parse Normal URL', () => {
    expect(ezParseSpecialUrl('http://example.com/arg1/arg2/arg3/'))
        .toBe('http://example.com/arg1/arg2/arg3/');
    expect(ezParseSpecialUrl('https://example.com/arg1/arg2/arg3/'))
        .toBe('https://example.com/arg1/arg2/arg3/');
    expect(ezParseSpecialUrl('ftp://example.com/arg1/arg2/arg3/'))
        .toBe('ftp://example.com/arg1/arg2/arg3/');
  });

  it('Parse Google Storage Url (gs://)', () => {
    const result = parseSpecialUrl('gs://bucket/dataset/layer/');
    expect(result).toBe('https://storage.googleapis.com/bucket/dataset/layer/');
  });

  it('Parse AWS S3 Url (s3://)', () => {
    const result = parseSpecialUrl('s3://bucket/dataset/layer/');
    expect(result).toBe('https://s3.amazonaws.com/bucket/dataset/layer/');
  });
});
