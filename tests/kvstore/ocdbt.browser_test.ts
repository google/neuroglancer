/**
 * @license
 * Copyright 2025 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/ocdbt/register_frontend.js";

import { describe, expect, test } from "vitest";
import { getKvStoreCompletions } from "#src/datasource/kvstore_completions.js";
import {
  formatCommitTime,
  formatVersion,
  parseCommitTimePrefix,
  parseVersion,
} from "#src/kvstore/ocdbt/version_specifier.js";
import {
  testKvStore,
  sharedKvStoreContext,
  testAutoDetect,
} from "#tests/kvstore/test_util.js";

declare const TEST_DATA_SERVER: string;

const BASE_URL = `${TEST_DATA_SERVER}kvstore/ocdbt/files_min_arity.ocdbt/`;

describe.for(["files_high_arity", "files_min_arity"])("%s", (name) => {
  testKvStore(
    async () => `${TEST_DATA_SERVER}kvstore/ocdbt/${name}.ocdbt/|ocdbt:`,
  );
});

describe("completion", () => {
  test("empty prefix", async () => {
    const url = `${BASE_URL}|ocdbt:`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Version specifier",
            "value": "@",
          },
          {
            "value": "baz/",
          },
          {
            "value": "%23|",
          },
          {
            "value": "a|",
          },
          {
            "value": "b|",
          },
          {
            "value": "c|",
          },
          {
            "value": "empty|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 66,
      }
    `);
  });

  test("single letter prefix", async () => {
    const url = `${BASE_URL}|ocdbt:b`;
    const completions = await getKvStoreCompletions(
      await sharedKvStoreContext(),
      {
        url,
      },
    );
    expect(completions).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "baz/",
          },
          {
            "value": "b|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 66,
      }
    `);
  });

  test("multi versions", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "Version specifier",
            "value": "@",
          },
          {
            "value": "key1|",
          },
          {
            "value": "key10|",
          },
          {
            "value": "key100|",
          },
          {
            "value": "key101|",
          },
          {
            "value": "key102|",
          },
          {
            "value": "key103|",
          },
          {
            "value": "key104|",
          },
          {
            "value": "key105|",
          },
          {
            "value": "key106|",
          },
          {
            "value": "key107|",
          },
          {
            "value": "key108|",
          },
          {
            "value": "key109|",
          },
          {
            "value": "key11|",
          },
          {
            "value": "key110|",
          },
          {
            "value": "key111|",
          },
          {
            "value": "key112|",
          },
          {
            "value": "key113|",
          },
          {
            "value": "key114|",
          },
          {
            "value": "key115|",
          },
          {
            "value": "key116|",
          },
          {
            "value": "key117|",
          },
          {
            "value": "key118|",
          },
          {
            "value": "key119|",
          },
          {
            "value": "key12|",
          },
          {
            "value": "key120|",
          },
          {
            "value": "key121|",
          },
          {
            "value": "key122|",
          },
          {
            "value": "key123|",
          },
          {
            "value": "key124|",
          },
          {
            "value": "key125|",
          },
          {
            "value": "key126|",
          },
          {
            "value": "key127|",
          },
          {
            "value": "key128|",
          },
          {
            "value": "key129|",
          },
          {
            "value": "key13|",
          },
          {
            "value": "key130|",
          },
          {
            "value": "key131|",
          },
          {
            "value": "key132|",
          },
          {
            "value": "key133|",
          },
          {
            "value": "key134|",
          },
          {
            "value": "key135|",
          },
          {
            "value": "key136|",
          },
          {
            "value": "key137|",
          },
          {
            "value": "key138|",
          },
          {
            "value": "key139|",
          },
          {
            "value": "key14|",
          },
          {
            "value": "key140|",
          },
          {
            "value": "key141|",
          },
          {
            "value": "key142|",
          },
          {
            "value": "key143|",
          },
          {
            "value": "key144|",
          },
          {
            "value": "key145|",
          },
          {
            "value": "key146|",
          },
          {
            "value": "key147|",
          },
          {
            "value": "key148|",
          },
          {
            "value": "key149|",
          },
          {
            "value": "key15|",
          },
          {
            "value": "key150|",
          },
          {
            "value": "key151|",
          },
          {
            "value": "key152|",
          },
          {
            "value": "key153|",
          },
          {
            "value": "key154|",
          },
          {
            "value": "key155|",
          },
          {
            "value": "key156|",
          },
          {
            "value": "key157|",
          },
          {
            "value": "key158|",
          },
          {
            "value": "key159|",
          },
          {
            "value": "key16|",
          },
          {
            "value": "key160|",
          },
          {
            "value": "key161|",
          },
          {
            "value": "key162|",
          },
          {
            "value": "key163|",
          },
          {
            "value": "key164|",
          },
          {
            "value": "key165|",
          },
          {
            "value": "key166|",
          },
          {
            "value": "key167|",
          },
          {
            "value": "key168|",
          },
          {
            "value": "key169|",
          },
          {
            "value": "key17|",
          },
          {
            "value": "key170|",
          },
          {
            "value": "key171|",
          },
          {
            "value": "key172|",
          },
          {
            "value": "key173|",
          },
          {
            "value": "key174|",
          },
          {
            "value": "key175|",
          },
          {
            "value": "key176|",
          },
          {
            "value": "key177|",
          },
          {
            "value": "key178|",
          },
          {
            "value": "key179|",
          },
          {
            "value": "key18|",
          },
          {
            "value": "key180|",
          },
          {
            "value": "key181|",
          },
          {
            "value": "key182|",
          },
          {
            "value": "key183|",
          },
          {
            "value": "key184|",
          },
          {
            "value": "key185|",
          },
          {
            "value": "key186|",
          },
          {
            "value": "key187|",
          },
          {
            "value": "key188|",
          },
          {
            "value": "key189|",
          },
          {
            "value": "key19|",
          },
          {
            "value": "key190|",
          },
          {
            "value": "key191|",
          },
          {
            "value": "key192|",
          },
          {
            "value": "key193|",
          },
          {
            "value": "key194|",
          },
          {
            "value": "key195|",
          },
          {
            "value": "key196|",
          },
          {
            "value": "key197|",
          },
          {
            "value": "key198|",
          },
          {
            "value": "key199|",
          },
          {
            "value": "key2|",
          },
          {
            "value": "key20|",
          },
          {
            "value": "key200|",
          },
          {
            "value": "key21|",
          },
          {
            "value": "key22|",
          },
          {
            "value": "key23|",
          },
          {
            "value": "key24|",
          },
          {
            "value": "key25|",
          },
          {
            "value": "key26|",
          },
          {
            "value": "key27|",
          },
          {
            "value": "key28|",
          },
          {
            "value": "key29|",
          },
          {
            "value": "key3|",
          },
          {
            "value": "key30|",
          },
          {
            "value": "key31|",
          },
          {
            "value": "key32|",
          },
          {
            "value": "key33|",
          },
          {
            "value": "key34|",
          },
          {
            "value": "key35|",
          },
          {
            "value": "key36|",
          },
          {
            "value": "key37|",
          },
          {
            "value": "key38|",
          },
          {
            "value": "key39|",
          },
          {
            "value": "key4|",
          },
          {
            "value": "key40|",
          },
          {
            "value": "key41|",
          },
          {
            "value": "key42|",
          },
          {
            "value": "key43|",
          },
          {
            "value": "key44|",
          },
          {
            "value": "key45|",
          },
          {
            "value": "key46|",
          },
          {
            "value": "key47|",
          },
          {
            "value": "key48|",
          },
          {
            "value": "key49|",
          },
          {
            "value": "key5|",
          },
          {
            "value": "key50|",
          },
          {
            "value": "key51|",
          },
          {
            "value": "key52|",
          },
          {
            "value": "key53|",
          },
          {
            "value": "key54|",
          },
          {
            "value": "key55|",
          },
          {
            "value": "key56|",
          },
          {
            "value": "key57|",
          },
          {
            "value": "key58|",
          },
          {
            "value": "key59|",
          },
          {
            "value": "key6|",
          },
          {
            "value": "key60|",
          },
          {
            "value": "key61|",
          },
          {
            "value": "key62|",
          },
          {
            "value": "key63|",
          },
          {
            "value": "key64|",
          },
          {
            "value": "key65|",
          },
          {
            "value": "key66|",
          },
          {
            "value": "key67|",
          },
          {
            "value": "key68|",
          },
          {
            "value": "key69|",
          },
          {
            "value": "key7|",
          },
          {
            "value": "key70|",
          },
          {
            "value": "key71|",
          },
          {
            "value": "key72|",
          },
          {
            "value": "key73|",
          },
          {
            "value": "key74|",
          },
          {
            "value": "key75|",
          },
          {
            "value": "key76|",
          },
          {
            "value": "key77|",
          },
          {
            "value": "key78|",
          },
          {
            "value": "key79|",
          },
          {
            "value": "key8|",
          },
          {
            "value": "key80|",
          },
          {
            "value": "key81|",
          },
          {
            "value": "key82|",
          },
          {
            "value": "key83|",
          },
          {
            "value": "key84|",
          },
          {
            "value": "key85|",
          },
          {
            "value": "key86|",
          },
          {
            "value": "key87|",
          },
          {
            "value": "key88|",
          },
          {
            "value": "key89|",
          },
          {
            "value": "key9|",
          },
          {
            "value": "key90|",
          },
          {
            "value": "key91|",
          },
          {
            "value": "key92|",
          },
          {
            "value": "key93|",
          },
          {
            "value": "key94|",
          },
          {
            "value": "key95|",
          },
          {
            "value": "key96|",
          },
          {
            "value": "key97|",
          },
          {
            "value": "key98|",
          },
          {
            "value": "key99|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 75,
      }
    `);
  });

  test("multi versions @", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:@`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "v200",
            "value": "2025-01-30T21:32:59.915170266Z/",
          },
          {
            "description": "v199",
            "value": "2025-01-30T21:32:59.907529813Z/",
          },
          {
            "description": "v198",
            "value": "2025-01-30T21:32:59.899171472Z/",
          },
          {
            "description": "v197",
            "value": "2025-01-30T21:32:59.890445567Z/",
          },
          {
            "description": "v196",
            "value": "2025-01-30T21:32:59.882664734Z/",
          },
          {
            "description": "v195",
            "value": "2025-01-30T21:32:59.874795394Z/",
          },
          {
            "description": "v194",
            "value": "2025-01-30T21:32:59.867415745Z/",
          },
          {
            "description": "v193",
            "value": "2025-01-30T21:32:59.859506131Z/",
          },
          {
            "description": "v192",
            "value": "2025-01-30T21:32:59.85208681Z/",
          },
          {
            "description": "v191",
            "value": "2025-01-30T21:32:59.844936515Z/",
          },
          {
            "description": "v190",
            "value": "2025-01-30T21:32:59.838038049Z/",
          },
          {
            "description": "v189",
            "value": "2025-01-30T21:32:59.831451435Z/",
          },
          {
            "description": "v188",
            "value": "2025-01-30T21:32:59.82395756Z/",
          },
          {
            "description": "v187",
            "value": "2025-01-30T21:32:59.817471451Z/",
          },
          {
            "description": "v186",
            "value": "2025-01-30T21:32:59.810523502Z/",
          },
          {
            "description": "v185",
            "value": "2025-01-30T21:32:59.803131173Z/",
          },
          {
            "description": "v184",
            "value": "2025-01-30T21:32:59.795923259Z/",
          },
          {
            "description": "v183",
            "value": "2025-01-30T21:32:59.789376083Z/",
          },
          {
            "description": "v182",
            "value": "2025-01-30T21:32:59.782663414Z/",
          },
          {
            "description": "v181",
            "value": "2025-01-30T21:32:59.775845803Z/",
          },
          {
            "description": "v180",
            "value": "2025-01-30T21:32:59.768952184Z/",
          },
          {
            "description": "v179",
            "value": "2025-01-30T21:32:59.761164455Z/",
          },
          {
            "description": "v178",
            "value": "2025-01-30T21:32:59.753600253Z/",
          },
          {
            "description": "v177",
            "value": "2025-01-30T21:32:59.744392584Z/",
          },
          {
            "description": "v176",
            "value": "2025-01-30T21:32:59.732677264Z/",
          },
          {
            "description": "v175",
            "value": "2025-01-30T21:32:59.723182335Z/",
          },
          {
            "description": "v174",
            "value": "2025-01-30T21:32:59.713576643Z/",
          },
          {
            "description": "v173",
            "value": "2025-01-30T21:32:59.703591276Z/",
          },
          {
            "description": "v172",
            "value": "2025-01-30T21:32:59.694980469Z/",
          },
          {
            "description": "v171",
            "value": "2025-01-30T21:32:59.684709254Z/",
          },
          {
            "description": "v170",
            "value": "2025-01-30T21:32:59.674890773Z/",
          },
          {
            "description": "v169",
            "value": "2025-01-30T21:32:59.666060381Z/",
          },
          {
            "description": "v168",
            "value": "2025-01-30T21:32:59.657304213Z/",
          },
          {
            "description": "v167",
            "value": "2025-01-30T21:32:59.647783686Z/",
          },
          {
            "description": "v166",
            "value": "2025-01-30T21:32:59.638971354Z/",
          },
          {
            "description": "v165",
            "value": "2025-01-30T21:32:59.629184204Z/",
          },
          {
            "description": "v164",
            "value": "2025-01-30T21:32:59.619610441Z/",
          },
          {
            "description": "v163",
            "value": "2025-01-30T21:32:59.610657854Z/",
          },
          {
            "description": "v162",
            "value": "2025-01-30T21:32:59.601570489Z/",
          },
          {
            "description": "v161",
            "value": "2025-01-30T21:32:59.591352112Z/",
          },
          {
            "description": "v160",
            "value": "2025-01-30T21:32:59.581193356Z/",
          },
          {
            "description": "v159",
            "value": "2025-01-30T21:32:59.571906863Z/",
          },
          {
            "description": "v158",
            "value": "2025-01-30T21:32:59.562975436Z/",
          },
          {
            "description": "v157",
            "value": "2025-01-30T21:32:59.551258602Z/",
          },
          {
            "description": "v156",
            "value": "2025-01-30T21:32:59.542915508Z/",
          },
          {
            "description": "v155",
            "value": "2025-01-30T21:32:59.534823333Z/",
          },
          {
            "description": "v154",
            "value": "2025-01-30T21:32:59.526810295Z/",
          },
          {
            "description": "v153",
            "value": "2025-01-30T21:32:59.519085767Z/",
          },
          {
            "description": "v152",
            "value": "2025-01-30T21:32:59.510203627Z/",
          },
          {
            "description": "v151",
            "value": "2025-01-30T21:32:59.499912772Z/",
          },
          {
            "description": "v50",
            "value": "2025-01-30T21:32:58.741091391Z/",
          },
          {
            "description": "v49",
            "value": "2025-01-30T21:32:58.733770038Z/",
          },
          {
            "description": "v48",
            "value": "2025-01-30T21:32:58.725633688Z/",
          },
          {
            "description": "v47",
            "value": "2025-01-30T21:32:58.717105275Z/",
          },
          {
            "description": "v46",
            "value": "2025-01-30T21:32:58.70988888Z/",
          },
          {
            "description": "v45",
            "value": "2025-01-30T21:32:58.702645896Z/",
          },
          {
            "description": "v44",
            "value": "2025-01-30T21:32:58.695803699Z/",
          },
          {
            "description": "v43",
            "value": "2025-01-30T21:32:58.687635677Z/",
          },
          {
            "description": "v42",
            "value": "2025-01-30T21:32:58.680444765Z/",
          },
          {
            "description": "v41",
            "value": "2025-01-30T21:32:58.672315573Z/",
          },
          {
            "description": "v40",
            "value": "2025-01-30T21:32:58.663607924Z/",
          },
          {
            "description": "v39",
            "value": "2025-01-30T21:32:58.655655309Z/",
          },
          {
            "description": "v38",
            "value": "2025-01-30T21:32:58.649450448Z/",
          },
          {
            "description": "v37",
            "value": "2025-01-30T21:32:58.642451615Z/",
          },
          {
            "description": "v36",
            "value": "2025-01-30T21:32:58.636364693Z/",
          },
          {
            "description": "v35",
            "value": "2025-01-30T21:32:58.629837282Z/",
          },
          {
            "description": "v34",
            "value": "2025-01-30T21:32:58.623469189Z/",
          },
          {
            "description": "v33",
            "value": "2025-01-30T21:32:58.616482142Z/",
          },
          {
            "description": "v32",
            "value": "2025-01-30T21:32:58.609234678Z/",
          },
          {
            "description": "v31",
            "value": "2025-01-30T21:32:58.602247321Z/",
          },
          {
            "description": "v30",
            "value": "2025-01-30T21:32:58.595214183Z/",
          },
          {
            "description": "v29",
            "value": "2025-01-30T21:32:58.588854668Z/",
          },
          {
            "description": "v28",
            "value": "2025-01-30T21:32:58.58269864Z/",
          },
          {
            "description": "v27",
            "value": "2025-01-30T21:32:58.575737362Z/",
          },
          {
            "description": "v26",
            "value": "2025-01-30T21:32:58.56769563Z/",
          },
          {
            "description": "v25",
            "value": "2025-01-30T21:32:58.560318856Z/",
          },
          {
            "description": "v24",
            "value": "2025-01-30T21:32:58.552615533Z/",
          },
          {
            "description": "v23",
            "value": "2025-01-30T21:32:58.544411524Z/",
          },
          {
            "description": "v22",
            "value": "2025-01-30T21:32:58.536776612Z/",
          },
          {
            "description": "v21",
            "value": "2025-01-30T21:32:58.528785227Z/",
          },
          {
            "description": "v20",
            "value": "2025-01-30T21:32:58.520580028Z/",
          },
          {
            "description": "v19",
            "value": "2025-01-30T21:32:58.513375995Z/",
          },
          {
            "description": "v18",
            "value": "2025-01-30T21:32:58.507041805Z/",
          },
          {
            "description": "v17",
            "value": "2025-01-30T21:32:58.499782226Z/",
          },
          {
            "description": "v16",
            "value": "2025-01-30T21:32:58.492011647Z/",
          },
          {
            "description": "v15",
            "value": "2025-01-30T21:32:58.484795694Z/",
          },
          {
            "description": "v14",
            "value": "2025-01-30T21:32:58.478250025Z/",
          },
          {
            "description": "v13",
            "value": "2025-01-30T21:32:58.471413106Z/",
          },
          {
            "description": "v12",
            "value": "2025-01-30T21:32:58.465446537Z/",
          },
          {
            "description": "v11",
            "value": "2025-01-30T21:32:58.458931396Z/",
          },
          {
            "description": "v10",
            "value": "2025-01-30T21:32:58.451666122Z/",
          },
          {
            "description": "v9",
            "value": "2025-01-30T21:32:58.443700437Z/",
          },
          {
            "description": "v8",
            "value": "2025-01-30T21:32:58.4359968Z/",
          },
          {
            "description": "v7",
            "value": "2025-01-30T21:32:58.426586311Z/",
          },
          {
            "description": "v6",
            "value": "2025-01-30T21:32:58.41927557Z/",
          },
          {
            "description": "v5",
            "value": "2025-01-30T21:32:58.411440602Z/",
          },
          {
            "description": "v4",
            "value": "2025-01-30T21:32:58.403966834Z/",
          },
          {
            "description": "v3",
            "value": "2025-01-30T21:32:58.395940026Z/",
          },
          {
            "description": "v2",
            "value": "2025-01-30T21:32:58.387664952Z/",
          },
          {
            "description": "v1",
            "value": "2025-01-30T21:32:58.378504069Z/",
          },
        ],
        "offset": 76,
      }
    `);
  });

  test("multi versions low arity @", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_low_arity.ocdbt/|ocdbt:@`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "v200",
            "value": "2025-01-30T21:33:01.412908716Z/",
          },
          {
            "description": "v199",
            "value": "2025-01-30T21:33:01.405073545Z/",
          },
          {
            "description": "v198",
            "value": "2025-01-30T21:33:01.397185009Z/",
          },
          {
            "description": "v197",
            "value": "2025-01-30T21:33:01.389666852Z/",
          },
          {
            "description": "v196",
            "value": "2025-01-30T21:33:01.383055122Z/",
          },
          {
            "description": "v195",
            "value": "2025-01-30T21:33:01.375776043Z/",
          },
          {
            "description": "v194",
            "value": "2025-01-30T21:33:01.369169594Z/",
          },
          {
            "description": "v193",
            "value": "2025-01-30T21:33:01.361236931Z/",
          },
          {
            "description": "v192",
            "value": "2025-01-30T21:33:01.353050669Z/",
          },
          {
            "description": "v191",
            "value": "2025-01-30T21:33:01.344525027Z/",
          },
          {
            "description": "v190",
            "value": "2025-01-30T21:33:01.336971058Z/",
          },
          {
            "description": "v189",
            "value": "2025-01-30T21:33:01.329331236Z/",
          },
          {
            "description": "v188",
            "value": "2025-01-30T21:33:01.322173692Z/",
          },
          {
            "description": "v187",
            "value": "2025-01-30T21:33:01.314665901Z/",
          },
          {
            "description": "v186",
            "value": "2025-01-30T21:33:01.305194002Z/",
          },
          {
            "description": "v185",
            "value": "2025-01-30T21:33:01.296328302Z/",
          },
          {
            "description": "v184",
            "value": "2025-01-30T21:33:01.2884889Z/",
          },
          {
            "description": "v183",
            "value": "2025-01-30T21:33:01.279548533Z/",
          },
          {
            "description": "v182",
            "value": "2025-01-30T21:33:01.272841026Z/",
          },
          {
            "description": "v181",
            "value": "2025-01-30T21:33:01.265876205Z/",
          },
          {
            "description": "v180",
            "value": "2025-01-30T21:33:01.258486834Z/",
          },
          {
            "description": "v179",
            "value": "2025-01-30T21:33:01.249556168Z/",
          },
          {
            "description": "v178",
            "value": "2025-01-30T21:33:01.241978649Z/",
          },
          {
            "description": "v177",
            "value": "2025-01-30T21:33:01.233743108Z/",
          },
          {
            "description": "v176",
            "value": "2025-01-30T21:33:01.226683489Z/",
          },
          {
            "description": "v175",
            "value": "2025-01-30T21:33:01.218208673Z/",
          },
          {
            "description": "v174",
            "value": "2025-01-30T21:33:01.211324534Z/",
          },
          {
            "description": "v173",
            "value": "2025-01-30T21:33:01.204150737Z/",
          },
          {
            "description": "v172",
            "value": "2025-01-30T21:33:01.196846366Z/",
          },
          {
            "description": "v171",
            "value": "2025-01-30T21:33:01.189114838Z/",
          },
          {
            "description": "v170",
            "value": "2025-01-30T21:33:01.182343292Z/",
          },
          {
            "description": "v169",
            "value": "2025-01-30T21:33:01.175344873Z/",
          },
          {
            "description": "v168",
            "value": "2025-01-30T21:33:01.167323742Z/",
          },
          {
            "description": "v167",
            "value": "2025-01-30T21:33:01.158600914Z/",
          },
          {
            "description": "v166",
            "value": "2025-01-30T21:33:01.151039247Z/",
          },
          {
            "description": "v165",
            "value": "2025-01-30T21:33:01.142758201Z/",
          },
          {
            "description": "v164",
            "value": "2025-01-30T21:33:01.134050239Z/",
          },
          {
            "description": "v163",
            "value": "2025-01-30T21:33:01.12352153Z/",
          },
          {
            "description": "v162",
            "value": "2025-01-30T21:33:01.114900939Z/",
          },
          {
            "description": "v161",
            "value": "2025-01-30T21:33:01.106381236Z/",
          },
          {
            "description": "v160",
            "value": "2025-01-30T21:33:01.097567209Z/",
          },
          {
            "description": "v159",
            "value": "2025-01-30T21:33:01.088362502Z/",
          },
          {
            "description": "v158",
            "value": "2025-01-30T21:33:01.07953878Z/",
          },
          {
            "description": "v157",
            "value": "2025-01-30T21:33:01.07118037Z/",
          },
          {
            "description": "v156",
            "value": "2025-01-30T21:33:01.062647525Z/",
          },
          {
            "description": "v155",
            "value": "2025-01-30T21:33:01.05270771Z/",
          },
          {
            "description": "v154",
            "value": "2025-01-30T21:33:01.044510219Z/",
          },
          {
            "description": "v153",
            "value": "2025-01-30T21:33:01.035482287Z/",
          },
          {
            "description": "v152",
            "value": "2025-01-30T21:33:01.027134931Z/",
          },
          {
            "description": "v151",
            "value": "2025-01-30T21:33:01.018348224Z/",
          },
          {
            "description": "v50",
            "value": "2025-01-30T21:33:00.255661377Z/",
          },
          {
            "description": "v49",
            "value": "2025-01-30T21:33:00.249546282Z/",
          },
          {
            "description": "v48",
            "value": "2025-01-30T21:33:00.24324847Z/",
          },
          {
            "description": "v47",
            "value": "2025-01-30T21:33:00.235482656Z/",
          },
          {
            "description": "v46",
            "value": "2025-01-30T21:33:00.229685581Z/",
          },
          {
            "description": "v45",
            "value": "2025-01-30T21:33:00.222619375Z/",
          },
          {
            "description": "v44",
            "value": "2025-01-30T21:33:00.216499339Z/",
          },
          {
            "description": "v43",
            "value": "2025-01-30T21:33:00.209718403Z/",
          },
          {
            "description": "v42",
            "value": "2025-01-30T21:33:00.203031256Z/",
          },
          {
            "description": "v41",
            "value": "2025-01-30T21:33:00.196992209Z/",
          },
          {
            "description": "v40",
            "value": "2025-01-30T21:33:00.190615007Z/",
          },
          {
            "description": "v39",
            "value": "2025-01-30T21:33:00.184409287Z/",
          },
          {
            "description": "v38",
            "value": "2025-01-30T21:33:00.177686632Z/",
          },
          {
            "description": "v37",
            "value": "2025-01-30T21:33:00.170663164Z/",
          },
          {
            "description": "v36",
            "value": "2025-01-30T21:33:00.164254955Z/",
          },
          {
            "description": "v35",
            "value": "2025-01-30T21:33:00.157221696Z/",
          },
          {
            "description": "v34",
            "value": "2025-01-30T21:33:00.150683623Z/",
          },
          {
            "description": "v33",
            "value": "2025-01-30T21:33:00.144124101Z/",
          },
          {
            "description": "v32",
            "value": "2025-01-30T21:33:00.136828804Z/",
          },
          {
            "description": "v31",
            "value": "2025-01-30T21:33:00.130206738Z/",
          },
          {
            "description": "v30",
            "value": "2025-01-30T21:33:00.123729003Z/",
          },
          {
            "description": "v29",
            "value": "2025-01-30T21:33:00.118311054Z/",
          },
          {
            "description": "v28",
            "value": "2025-01-30T21:33:00.111646289Z/",
          },
          {
            "description": "v27",
            "value": "2025-01-30T21:33:00.104021875Z/",
          },
          {
            "description": "v26",
            "value": "2025-01-30T21:33:00.098323976Z/",
          },
          {
            "description": "v25",
            "value": "2025-01-30T21:33:00.091713725Z/",
          },
          {
            "description": "v24",
            "value": "2025-01-30T21:33:00.085808147Z/",
          },
          {
            "description": "v23",
            "value": "2025-01-30T21:33:00.079917954Z/",
          },
          {
            "description": "v22",
            "value": "2025-01-30T21:33:00.07399539Z/",
          },
          {
            "description": "v21",
            "value": "2025-01-30T21:33:00.067625089Z/",
          },
          {
            "description": "v20",
            "value": "2025-01-30T21:33:00.061424053Z/",
          },
          {
            "description": "v19",
            "value": "2025-01-30T21:33:00.054913429Z/",
          },
          {
            "description": "v18",
            "value": "2025-01-30T21:33:00.049050718Z/",
          },
          {
            "description": "v17",
            "value": "2025-01-30T21:33:00.043422024Z/",
          },
          {
            "description": "v16",
            "value": "2025-01-30T21:33:00.038075507Z/",
          },
          {
            "description": "v15",
            "value": "2025-01-30T21:33:00.032736666Z/",
          },
          {
            "description": "v14",
            "value": "2025-01-30T21:33:00.027587276Z/",
          },
          {
            "description": "v13",
            "value": "2025-01-30T21:33:00.022069483Z/",
          },
          {
            "description": "v12",
            "value": "2025-01-30T21:33:00.016382316Z/",
          },
          {
            "description": "v11",
            "value": "2025-01-30T21:33:00.00993712Z/",
          },
          {
            "description": "v10",
            "value": "2025-01-30T21:33:00.003133934Z/",
          },
          {
            "description": "v9",
            "value": "2025-01-30T21:32:59.996682626Z/",
          },
          {
            "description": "v8",
            "value": "2025-01-30T21:32:59.990615099Z/",
          },
          {
            "description": "v7",
            "value": "2025-01-30T21:32:59.983298304Z/",
          },
          {
            "description": "v6",
            "value": "2025-01-30T21:32:59.976923153Z/",
          },
          {
            "description": "v5",
            "value": "2025-01-30T21:32:59.968640783Z/",
          },
          {
            "description": "v4",
            "value": "2025-01-30T21:32:59.961757956Z/",
          },
          {
            "description": "v3",
            "value": "2025-01-30T21:32:59.95332112Z/",
          },
          {
            "description": "v2",
            "value": "2025-01-30T21:32:59.945945456Z/",
          },
          {
            "description": "v1",
            "value": "2025-01-30T21:32:59.931662761Z/",
          },
        ],
        "offset": 75,
      }
    `);
  });

  test("multi versions @v", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:@v`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "description": "2025-01-30T21:32:59.915170266Z",
            "value": "v200/",
          },
          {
            "description": "2025-01-30T21:32:59.907529813Z",
            "value": "v199/",
          },
          {
            "description": "2025-01-30T21:32:59.899171472Z",
            "value": "v198/",
          },
          {
            "description": "2025-01-30T21:32:59.890445567Z",
            "value": "v197/",
          },
          {
            "description": "2025-01-30T21:32:59.882664734Z",
            "value": "v196/",
          },
          {
            "description": "2025-01-30T21:32:59.874795394Z",
            "value": "v195/",
          },
          {
            "description": "2025-01-30T21:32:59.867415745Z",
            "value": "v194/",
          },
          {
            "description": "2025-01-30T21:32:59.859506131Z",
            "value": "v193/",
          },
        ],
        "offset": 76,
      }
    `);
  });

  test("multi versions @v1", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:@v1`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "v1/",
          },
        ],
        "offset": 76,
      }
    `);
  });

  test("multi versions @v1/", async () => {
    expect(
      await getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:@v1/`,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completions": [
          {
            "value": "key1|",
          },
        ],
        "defaultCompletion": undefined,
        "offset": 79,
      }
    `);
  });

  test("multi versions @xxx/", async () => {
    await expect(
      getKvStoreCompletions(await sharedKvStoreContext(), {
        url: `${TEST_DATA_SERVER}kvstore/ocdbt/multi_version_high_arity.ocdbt/|ocdbt:@xxx/`,
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Invalid OCDBT version specifier: "xxx"]`,
    );
  });
});

test("auto detect", async () => {
  expect(await testAutoDetect(BASE_URL)).toMatchInlineSnapshot(`
    [
      {
        "description": "OCDBT database",
        "suffix": "ocdbt:",
      },
    ]
  `);
});

describe("version specifier parsing", () => {
  describe("valid round trip", () => {
    test.for([
      "v1",
      "v2",
      "v18446744073709551615",
      "2025-01-01T01:23:45Z",
      "2025-01-01T01:23:45.5Z",
      "2025-01-28T18:11:06.511694032Z",
    ])("%s", (version) => {
      const parsed = parseVersion(version);
      expect(formatVersion(parsed)).toEqual(version);
    });
  });

  describe("valid non-round-trip", () => {
    test.for([["2025-01-01T01:23:45.Z", "2025-01-01T01:23:45Z"]])(
      "%s -> %s",
      ([a, b]) => {
        const parsed = parseVersion(a);
        const parsed2 = parseVersion(b);
        expect(parsed).toEqual(parsed2);
        expect(formatVersion(parsed)).toEqual(b);
      },
    );
  });

  describe("invalid", () => {
    test.for(["v0", "", "v", "v18446744073709551616", "2025-01-01T01:23:4Z"])(
      "%s",
      (version) => {
        expect(() => parseVersion(version)).toThrow();
      },
    );
  });
});

describe("commit time prefix", () => {
  describe("valid prefix", () => {
    test.for([
      ["", "0000-01-01T00:00:00Z", "9999-12-31T23:59:59.999999999Z"],
      ["1", "1000-01-01T00:00:00Z", "1999-12-31T23:59:59.999999999Z"],
      ["1000", "1000-01-01T00:00:00Z", "1000-12-31T23:59:59.999999999Z"],
      ["1000-", "1000-01-01T00:00:00Z", "1000-12-31T23:59:59.999999999Z"],
      ["1000-0", "1000-01-01T00:00:00Z", "1000-09-30T23:59:59.999999999Z"],
      ["1000-1", "1000-10-01T00:00:00Z", "1000-12-31T23:59:59.999999999Z"],
      ["1000-10", "1000-10-01T00:00:00Z", "1000-10-31T23:59:59.999999999Z"],
      ["1000-02", "1000-02-01T00:00:00Z", "1000-02-28T23:59:59.999999999Z"],
      ["1000-02-0", "1000-02-01T00:00:00Z", "1000-02-09T23:59:59.999999999Z"],
      ["1000-02-1", "1000-02-10T00:00:00Z", "1000-02-19T23:59:59.999999999Z"],
      ["1000-02-2", "1000-02-20T00:00:00Z", "1000-02-28T23:59:59.999999999Z"],
      ["1000-02-20", "1000-02-20T00:00:00Z", "1000-02-20T23:59:59.999999999Z"],
      [
        "1000-02-20T1",
        "1000-02-20T10:00:00Z",
        "1000-02-20T19:59:59.999999999Z",
      ],
      [
        "1000-02-20T2",
        "1000-02-20T20:00:00Z",
        "1000-02-20T23:59:59.999999999Z",
      ],
      [
        "1000-02-20T20:",
        "1000-02-20T20:00:00Z",
        "1000-02-20T20:59:59.999999999Z",
      ],
      [
        "1000-02-20T20:4",
        "1000-02-20T20:40:00Z",
        "1000-02-20T20:49:59.999999999Z",
      ],
      [
        "1000-02-20T20:45",
        "1000-02-20T20:45:00Z",
        "1000-02-20T20:45:59.999999999Z",
      ],
      [
        "1000-02-20T20:45:01",
        "1000-02-20T20:45:01Z",
        "1000-02-20T20:45:01.999999999Z",
      ],
      [
        "1000-02-20T20:45:01.3",
        "1000-02-20T20:45:01.3Z",
        "1000-02-20T20:45:01.399999999Z",
      ],
      [
        "1000-02-20T20:45:01.388",
        "1000-02-20T20:45:01.388Z",
        "1000-02-20T20:45:01.388999999Z",
      ],
      [
        "1000-02-20T20:45:01.9999999999",
        "1000-02-20T20:45:01.999999999Z",
        "1000-02-20T20:45:01.999999999Z",
      ],
    ])('"%s" -> [%s, %s]', ([prefix, expectedMin, expectedMax]) => {
      const [min, max] = parseCommitTimePrefix(prefix);
      expect.soft(formatCommitTime(min)).toEqual(expectedMin);
      expect.soft(formatCommitTime(max)).toEqual(expectedMax);
    });
  });

  describe("invalid prefix", () => {
    test.for([
      ["99999", /Expected prefix of .*/],
      ["1000-3", "Invalid month prefix: 3"],
      ["1000-02-3", "Invalid day prefix: 3"],
    ] as const)("%s", ([prefix, error]) => {
      expect(() => parseCommitTimePrefix(prefix)).toThrowError(error);
    });
  });
});
