import {cancellableFetchSpecialOk, parseSpecialUrl} from 'neuroglancer/util/special_protocol_request';

import {RefCounted} from 'neuroglancer/util/disposable';
import { CredentialsManager } from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {responseJson} from 'neuroglancer/util/http_request';

export class Test extends RefCounted {

    constructor(public credentialsManager: CredentialsManager) {
        super();
    }


    async getUser() {
        const url = `middleauth+https://globalv1.daf-apis.com/auth/api/v1/user/cache`;

        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);

        console.log('getuser', parsedUrl, credentialsProvider);
        return StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  return json;
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading user:`});
    }

    async getDatasets1() {
        const url = `middleauth+https://globalv1.daf-apis.com/auth/api/v1/dataset`;

        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);

        console.log('getDatasets1', parsedUrl, credentialsProvider);
        return StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  return json;
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading dataset:`});
    }

    async getUser2() {
        const url = `middleauth+https://authsl1.middleauth.com/auth/api/v1/user/cache`;

        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);

        console.log('getuser2', parsedUrl, credentialsProvider);
        return StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  return json;
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading user:`});
    }

    async getDatasets2() {
        const url = `middleauth+https://authsl1.middleauth.com/auth/api/v1/dataset`;

        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);

        console.log('getDatasets2', parsedUrl, credentialsProvider);
        return StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  return json;
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading dataset:`});
    }

    async logout() {
        const url = `middleauth+https://globalv1.daf-apis.com/auth/api/v1/logout`;

        const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(url, this.credentialsManager);

        StatusMessage.forPromise(
            cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {}, responseJson)
                .then(json => {
                  return json;
                }),
            {initialMessage: `Loading state from ${url}`, errorPrefix: `Error loading user:`});
    }
}

