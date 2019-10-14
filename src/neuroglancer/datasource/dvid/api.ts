import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {responseJson, cancellableFetchOk} from 'neuroglancer/util/http_request';

export interface HttpCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  payload?: string;
}

export class DVIDInstance {
  constructor(public baseUrl: string, public nodeKey: string) {}

  getNodeApiUrl(): string {
    return `${this.baseUrl}/api/node/${this.nodeKey}`;
  }
}

function responseText(response: Response): Promise<any> {
  return response.text();
}

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: 'arraybuffer' },
  cancellationToken?: CancellationToken): Promise<ArrayBuffer>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: 'json' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: '' }, cancellationToken?: CancellationToken): Promise<any>;

export function makeRequest(
  instance: DVIDInstance,
  httpCall: HttpCall & { responseType: XMLHttpRequestResponseType },
  cancellationToken: CancellationToken = uncancelableToken): any {
    let requestInfo = `${instance.getNodeApiUrl()}${httpCall.path}`;
    let init = { method: httpCall.method, body: httpCall.payload };

    if (httpCall.responseType === '') {
      return cancellableFetchOk(requestInfo, init, responseText, cancellationToken);
    } else {
      return cancellableFetchOk(requestInfo, init, responseJson, cancellationToken);
    }
}
