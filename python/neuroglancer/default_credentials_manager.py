# @license
# Copyright 2017 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from . import credentials_provider, google_credentials, boss_credentials, dvid_credentials

default_credentials_manager = credentials_provider.CredentialsManager()
boss_credentials_provider = boss_credentials.BossCredentialsProvider()
default_credentials_manager.register(
    u'google-brainmaps',
    lambda _parameters: google_credentials.GoogleOAuth2FlowCredentialsProvider(
        client_id=u'639403125587-ue3c18dalqidqehs1n1p5rjvgni5f7qu.apps.googleusercontent.com',
        client_secret=u'kuaqECaVXOKEJ2L6ifZu4Aqt',
        scopes=[u'https://www.googleapis.com/auth/brainmaps'],
    ))

default_credentials_manager.register(
    u'gcs',
    lambda _parameters: google_credentials.get_google_application_default_credentials_provider())

default_credentials_manager.register(
    u'boss',
    lambda _parameters: boss_credentials_provider
)

default_credentials_manager.register(
    u'DVID',
    lambda parameters: dvid_credentials.get_tokenbased_application_default_credentials_provider(parameters)
)

def set_boss_token(token):
    boss_credentials_provider.set_token(token)
