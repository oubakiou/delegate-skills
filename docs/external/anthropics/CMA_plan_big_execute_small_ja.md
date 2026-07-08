---
source_notebook: 'https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb'
description: 'ソースノートブックの非公式 Markdown 変換'
original_copyright: 'Copyright (c) 2023 Anthropic'
license: 'MIT License'
license_url: 'https://github.com/anthropics/claude-cookbooks/blob/main/LICENSE'
---

# コーディネーターパターン: 大きなモデルで計画し、小さなモデルで実行する

## はじめに

ほとんどの agent ワークロードには、その内部に大きく異なる 2 種類の仕事があります。少量の計画と判断、そして大量の機械的な読み取りと実行です。Web リサーチはその極端な例で、このノートブックでもそれを題材にします。20 個の事実を権威ある情報源で検証するには、数十万 token に及ぶ Web ページをモデルに通す必要があり、frontier モデルの料金では、その読み取りコストが支出の大半を占めます。

コーディネーターパターンは、この 2 つのワークロードを分離します。frontier モデルが調査を計画し、回答を統合しますが、生の Web ページには一切触れません。安価な worker がそれぞれ独立した並列 context window の中ですべての読み取りを行い、要約された findings を返します。このノートブックでは、その分離を正直に計測します。現実的な代替案、つまり同じツールを持ち、同じ検証基準を課された 1 つの frontier agent を、同じ質問で走らせ、実際の請求額と実際の経過時間を比較します。著者らの実行では、両方式はほぼ同量を読み取り、チーム方式はおよそ 2.5 倍安く、3 倍速くなり、入力 token の 84-98% が worker レートで請求されました。

**この cookbook を終えると、次のことができるようになります。**

- `multiagent` の coordinator フィールドを使って、frontier coordinator と安価な search worker からなる 2 モデルのチームを構成する
- session event stream（`thread_created`、`thread_message_sent`、`thread_message_received`）で委譲の進行をライブに追う
- 厳密さをそろえた単独 frontier の control を実行し、実際の請求額を比較する
- 型付きの thread ごとの累積 `usage` で各 thread を計測する

同じ経済性は、安価なモデルが token の重い部分を担当できるあらゆるワークロードに当てはまります。たとえば、ドキュメントレビュー、ログ分析、コードベース全体の調査などです。

![コーディネーターパターンのアーキテクチャ: ユーザーの質問は自前のツールを持たない frontier モデルの coordinator に渡される。coordinator は各公園につき 1 つの brief を並列の小型モデル search worker に送り、要約された findings を受け取る。open web に触れるのは worker だけで、web search と page fetch を使う。coordinator は最終回答を統合する。](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/managed_agents/example_data/plan_big_execute_small/architecture_diagram.png)

## 前提条件

このガイドに従う前に、次を用意してください。

**必要な知識:**

- Python の基礎
- Managed Agents の基本、つまり agents、environments、sessions、streaming event loop への理解（[`CMA_iterate_fix_failing_tests.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_iterate_fix_failing_tests.ipynb) がこれらをすべて紹介しています）

**必要なツール:**

- Python 3.11 以降
- Managed Agents beta にアクセスできる Anthropic API key（[ここで取得できます](https://console.anthropic.com)）

`multiagent` フィールドをまだ見たことがなければ、[`CMA_coordinate_specialist_team.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_coordinate_specialist_team.ipynb) が、異種 specialist team を使ってそれを紹介しています。このノートブックでは、最も単純なチーム、つまり 1 種類の worker だけを使います。ここでの論点はチーム設計ではなく、コスト構造だからです。

## セットアップ

```python
%%capture
%pip install -qU anthropic python-dotenv
```

```python
import os
import time

import anthropic
from dotenv import load_dotenv

load_dotenv()

BETAS = ["managed-agents-2026-04-01"]

# The frontier model plans and synthesizes; the cheap model reads the web.
COORDINATOR_MODEL = os.environ.get("COOKBOOK_COORDINATOR_MODEL", "claude-fable-5")
WORKER_MODEL = os.environ.get("COOKBOOK_WORKER_MODEL", "claude-sonnet-5")

client = anthropic.Anthropic()
```

## 1. チーム: 安価な読み手と高価な考え手

2 つの agent 定義でチーム全体ができます。

**worker** は、ドキュメントの用語では coordinator が roster から spawn できる subagent であり、通常の agent です。モデル、`web_search` と `web_fetch` だけに絞った toolset、そして system prompt を持ちます。各 worker instance は、自分の session thread の中で 1 つの焦点化された sub-question を調査するため、読み込んだ巨大な Web ページが他の誰かの context に入ることはありません。

**coordinator** は自前のツールを持たず、worker を指定する `multiagent` roster だけを持ちます。この 1 つのフィールドが coordinator にする要素です。サーバーは自動的に `create_agent`、`send_to_agent`、`wait_for_agents`、`list_agents` を coordinator に与え、同じ仕組みで worker には `submit_result` と `send_to_parent` を与えます。これらのツールを自分で定義する必要はありません。

この関係について知っておくべきことが 2 つあります。第一に、roster は coordinator が作成または更新された時点で snapshot されます。worker の定義を変えたら、coordinator を更新するか再作成してください。第二に、より見落としやすい点として、**coordinator は roster agents について何も見ることができません**。prompt も、名前も、説明も見えません。`create_agent` ツールが受け取るのは素の agent name と task string だけです。coordinator が worker について信じていることはすべて、自分自身の system prompt から来ます。そのため、その説明と実際の worker prompt を一致させてください。サーバー側では何も強制されません。（roster に agent が 1 つしかない場合、要求された名前はどれでもその 1 つの worker に解決されます。複数の worker type がある場合は、coordinator の prompt で明示的に名前を付けてください。）

```python
worker = client.beta.agents.create(
    name="search-worker",
    model=WORKER_MODEL,
    # Everything off except the two web tools: the worker's job is
    # reading, and scoping keeps the cheap model from wandering into
    # bash or the filesystem. It's also the security boundary: workers
    # read arbitrary (untrusted) web pages, so a worker that can only
    # search, fetch, and report back is the blast radius you want for
    # that input — and the coordinator reading the reports has no
    # tools at all.
    tools=[
        {
            "type": "agent_toolset_20260401",
            "default_config": {"enabled": False},
            "configs": [
                {"name": "web_search", "enabled": True},
                {"name": "web_fetch", "enabled": True},
            ],
        }
    ],
    system=(
        "You are a search worker researching one focused sub-question for "
        "a coordinator. Use web_search and web_fetch to find the answer. "
        "Be thorough: try multiple query phrasings, follow promising "
        "links, and cross-check facts across sources. Report back with "
        "the specific answer you found and the evidence (URLs, quotes) "
        "that supports it. If you could not find a definitive answer, say "
        "exactly what you did find and what remains uncertain. Always "
        "finish by calling submit_result."
    ),
    betas=BETAS,
)

coordinator = client.beta.agents.create(
    name="search-coordinator",
    model=COORDINATOR_MODEL,
    multiagent={
        "type": "coordinator",
        "agents": [{"type": "agent", "id": worker.id}],
    },
    system=(
        "You are coordinating a team of search workers to answer a hard "
        "web-research question. Your workers have web_search and "
        "web_fetch; you do not. Break the question into focused "
        "sub-questions and delegate each to a worker via create_agent. "
        "Run several workers in parallel on independent sub-questions, "
        "and ALWAYS call wait_for_agents after spawning before drawing "
        "any conclusion. When a worker reports, decide whether its "
        "findings answer the sub-question or whether to send a follow-up "
        "with send_to_agent. If a worker returns an infrastructure error "
        "(rate limit, timeout) instead of findings, re-assign the same "
        "sub-question to a fresh worker. Once you have enough evidence, "
        "synthesize the workers' findings into a single final answer to "
        "the original question."
    ),
    betas=BETAS,
)

print(f"worker      {worker.id}")
print(f"coordinator {coordinator.id}")
```

```text
worker      agent_01YDJ3havNfM7FUu2X4xE5UF
coordinator agent_015MHQnJYMc51iXmhVDVrWZm
```

## 2. 調査質問を実行する

environment と coordinator 用の session を作成し、質問を `user.message` として送り、stream します。session-level stream は coordinator の primary thread、つまり実行全体の要約ビューです。worker thread は委譲トラフィックとしてそこに現れます。worker が spawn されたときの `session.thread_created`、coordinator が sub-question を渡したときの `agent.thread_message_sent`、findings が返ってきたときの `agent.thread_message_received` です。

質問は coverage task です。20 個の事実（10 の公園 x 2 つの属性）それぞれを、特定の権威ある情報源で検証しなければなりません。coverage question はこのパターンが得意なところです。読み取りが必須だからです。誰も記憶だけで答えることはできないため、残る問題は、その読み取りがどの料金で請求されるか、そして並列に行われるかどうかだけです。（[BrowseComp](https://arxiv.org/abs/2504.12516) のような benchmark 形式で、広い探索空間に隠れた 1 つの答えを見つける discovery question では、frontier モデルの探索直感がより報われ、差は小さくなります。）

```python
env = client.beta.environments.create(
    name="research-fanout",
    config={"type": "anthropic_cloud", "networking": {"type": "unrestricted"}},
)

session = client.beta.sessions.create(
    agent=coordinator.id,
    environment_id=env.id,
    betas=BETAS,
)

QUESTION = (
    "For each of the ten largest national parks in the contiguous United "
    "States by area, find: the current standard private-vehicle entrance "
    "fee, and whether the park currently requires a timed-entry or "
    "day-use reservation for peak season. Each fact must be verified "
    "against that park's official nps.gov pages (fees page and alerts/"
    "reservations page) - not from third-party summaries. Give park, fee, "
    "reservation requirement, and the nps.gov URLs you used."
)

t_start = time.monotonic()

client.beta.sessions.events.send(
    session.id,
    betas=BETAS,
    events=[{"type": "user.message", "content": [{"type": "text", "text": QUESTION}]}],
)


def text_of(content):
    return "".join(b.text for b in content or [] if b.type == "text")


def clip(s, n=160):
    return s[:n] + ("..." if len(s) > n else "")


final_answer = ""
with client.beta.sessions.events.stream(session.id, betas=BETAS) as stream:
    for ev in stream:
        match ev.type:
            case "agent.message":
                if text := text_of(ev.content).strip():
                    final_answer = text
                    print(f"[coordinator] {clip(text, 200)}")
            case "session.thread_created":
                print(f"[spawn] {ev.agent_name} ({ev.session_thread_id})")
            case "agent.thread_message_sent":
                print(f"[delegate -> {ev.to_agent_name}] {clip(text_of(ev.content))}")
            case "agent.thread_message_received":
                print(f"[report <- {ev.from_agent_name}] {clip(text_of(ev.content))}")
            case "session.status_idle":
                break

print(f"\n[team finished in {time.monotonic() - t_start:.0f}s]")
print("=" * 70)
print(final_answer)
```

```text
[spawn] search-worker (sthr_01F32moz43gj3cxRPrgS67jf)
[delegate -> search-worker] You are a web research worker. Research Death Valley National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or ...
```

```text
[spawn] search-worker (sthr_01R1qqTRXyARsqGebN1zqer1)
[delegate -> search-worker] You are a web research worker. Research Yellowstone National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or n...
```

```text
[spawn] search-worker (sthr_01UBFmhdgLajS4MR4Lukk1YD)
[delegate -> search-worker] You are a web research worker. Research Everglades National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or ne...
```

```text
[spawn] search-worker (sthr_01TdgcdgMm4J9ugpvTxADCq5)
[delegate -> search-worker] You are a web research worker. Research Grand Canyon National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or ...
```

```text
[spawn] search-worker (sthr_01PVtf1smDJMTEyw5f6Yx4rc)
[delegate -> search-worker] You are a web research worker. Research Glacier National Park (Montana) using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs...
```

```text
[spawn] search-worker (sthr_01PNQou4A6DVaLZkRsamEJkz)
[delegate -> search-worker] You are a web research worker. Research Olympic National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or news ...
```

```text
[spawn] search-worker (sthr_012wGNTHaSLEKox6qzL3r2cn)
[delegate -> search-worker] You are a web research worker. Research Big Bend National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or news...
```

```text
[spawn] search-worker (sthr_01SLZ1PDc2W5VqsSNGaQGMQm)
[delegate -> search-worker] You are a web research worker. Research Joshua Tree National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or n...
```

```text
[spawn] search-worker (sthr_01S5TWC3pjmAfYYSSPZBzv4k)
[delegate -> search-worker] You are a web research worker. Research Yosemite National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or news...
```

```text
[spawn] search-worker (sthr_01UrnhFkeooc8bSQPzXKXyGB)
[delegate -> search-worker] You are a web research worker. Research Kings Canyon National Park using ONLY official nps.gov pages (no third-party summaries like Wikipedia, travel blogs, or ...
```

```text
[coordinator] I've identified the ten largest national parks in the contiguous U.S. by area (Death Valley, Yellowstone, Everglades, Grand Canyon, Glacier, Olympic, Big Bend, Joshua Tree, Yosemite, and Kings Canyon)...
```

```text
[report <- search-worker] Research complete — Big Bend National Park (nps.gov official sources only):

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $30.00
   - "Private Vehicle $30.00 — Adm...
```

```text
[coordinator] Big Bend is confirmed: **$30 private-vehicle fee (7 days), no timed-entry or day-use reservation required** — verified on the park's official fees page and alerts page. Nine parks still in progress; I...
```

```text
[report <- search-worker] Research complete — both facts verified directly on official nps.gov pages.

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $35.00
- This covers one private, non-com...
```

```text
[coordinator] Yellowstone is confirmed: **$35 private-vehicle fee (7 days), no timed-entry/vehicle reservation required** — the fees page explicitly states vehicle reservations are not needed to enter. Eight parks ...
[report <- search-worker] Research complete — both facts verified directly on nps.gov (fetched pages below).

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $35.00
- Source: https://www.nps.g...
```

```text
[coordinator] Grand Canyon is confirmed: **$35 private-vehicle fee (7 days, South Rim), no timed-entry or day-use reservation required** — the fees page explicitly says "No reservation needed for entry, no timed en...
[report <- search-worker] Research complete — both facts verified directly on nps.gov (no third-party sources used).

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE
- $30.00 — "Private Vehicle...
```

```text
[coordinator] Joshua Tree is confirmed: **$30 private-vehicle fee (7 days), no timed-entry or day-use reservation required** — only campgrounds, Keys Ranch tours, and backcountry permits require reservations. Six p...
[report <- search-worker] RESEARCH RESULTS: Kings Canyon / Sequoia & Kings Canyon National Parks (nps.gov "seki" — Kings Canyon is jointly administered with Sequoia NP under the NPS unit...
```

```text
[coordinator] Kings Canyon is confirmed: **$35 private-vehicle fee (valid 1–7 days, covers both Sequoia & Kings Canyon, which are jointly administered), no timed-entry or day-use reservation required for entry**. F...
[report <- search-worker] Research complete on Glacier National Park (nps.gov only sources):

**1) Standard private-vehicle entrance fee**
- Current standard vehicle fee: $35.00 (summer ...
```

```text
[coordinator] Glacier is confirmed: **$35 private-vehicle fee ($25 winter rate Nov 1–Apr 30), and no vehicle reservations required in any area of the park for 2026** — a notable change, since Going-to-the-Sun Road ...
[report <- search-worker] YOSEMITE NATIONAL PARK — Official nps.gov Research Results

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $35.00
- Verified on https://www.nps.gov/yose/planyourvisi...
```

```text
[coordinator] Yosemite is confirmed: **$35 private-vehicle fee (7 days), and no timed-entry reservation for 2026** — the park's own Entrance Reservations page announces it discontinued the timed-reservation system ...
[report <- search-worker] RESEARCH RESULTS: Death Valley National Park (nps.gov only)

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $30.00
- Source verified: https://www.nps.gov/deva/planyo...
```

```text
[coordinator] Death Valley is confirmed: **$30 private-vehicle fee (7 days), no timed-entry or day-use reservation required**. Two parks still pending: Everglades and Olympic.
[report <- search-worker] EVERGLADES NATIONAL PARK — RESEARCH RESULTS (nps.gov only)

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE: $35.00 (7-day pass, admits passholder + all passengers in ...
```

```text
[coordinator] Everglades is confirmed: **$35 private-vehicle fee (7 days, all entrances), no timed-entry or day-use reservation required** — the worker also flagged and correctly discounted a stale legacy page show...
```

```text
[report <- search-worker] OLYMPIC NATIONAL PARK — RESEARCH RESULTS (all sourced from official nps.gov pages only)

1) STANDARD PRIVATE-VEHICLE ENTRANCE FEE
- Fee: $30.00 USD for a "Priva...
```

```text
[coordinator] All ten workers have reported, with each fact verified directly against official nps.gov pages. Here is the complete picture:

## The 10 Largest National Parks in the Contiguous U.S. — Fees & Entry Re...

[team finished in 194s]
======================================================================
All ten workers have reported, with each fact verified directly against official nps.gov pages. Here is the complete picture:

## The 10 Largest National Parks in the Contiguous U.S. — Fees & Entry Reservations

| # | Park | Private-Vehicle Fee | Timed-Entry / Day-Use Reservation? |
|---|------|--------------------|-----------------------------------|
| 1 | **Death Valley** | $30 (7 days) | **No** |
| 2 | **Yellowstone** | $35 (7 days) | **No** — fees page explicitly states vehicle reservations are not needed |
| 3 | **Everglades** | $35 (7 days, all entrances) | **No** |
| 4 | **Grand Canyon** | $35 (7 days) | **No** — "No reservation needed for entry, no timed entry" (note: North Rim closed for 2025 season due to Dragon Bravo Fire) |
| 5 | **Glacier** | $35 summer / $25 winter (Nov 1–Apr 30) | **No** — "No vehicle reservations are required in any areas of the park in 2026" (reservations were used 2021–2024 on Going-to-the-Sun Road, now discontinued) |
| 6 | **Olympic** | $30 (7 days) | **No** — "No reservations are required for entrance to the park" |
| 7 | **Big Bend** | $30 (7 days) | **No** — "There are no reservations required for entering Big Bend National Park" |
| 8 | **Joshua Tree** | $30 (7 days) | **No** — "No advance reservations are needed to enter Joshua Tree National Park" |
| 9 | **Yosemite** | $35 (7 days) | **No** — park announced it will **not** use its timed-reservation system in 2026 (a reversal; reservations were required in 2025 peak season) |
| 10 | **Kings Canyon** (jointly administered with Sequoia as "SEKI") | $35 (1–7 days, valid for both parks) | **No** — "Reservations are not required to enter the parks" |

**Headline finding:** Currently, **none** of the ten largest contiguous-U.S. parks requires a timed-entry or day-use reservation for general entry — including the two with recent reservation systems (Glacier and Yosemite), both of which have officially discontinued them per their own nps.gov pages. Reservations remain required only for ancillary activities (campgrounds, wilderness permits, cave/ranch tours, tram tours), not park entry.

### Official nps.gov sources used per park

- **Death Valley**: [fees](https://www.nps.gov/deva/planyourvisit/fees.htm) · [alerts/conditions](https://www.nps.gov/deva/planyourvisit/conditions.htm) (no reservation language anywhere; no reservations page exists)
- **Yellowstone**: [fees](https://www.nps.gov/yell/planyourvisit/fees.htm) (contains the "Vehicle Reservations Not Required" callout) · [conditions](https://www.nps.gov/yell/planyourvisit/conditions.htm)
- **Everglades**: [fees](https://www.nps.gov/ever/planyourvisit/fees.htm) · [permits & reservations](https://www.nps.gov/ever/planyourvisit/permits-and-reservations.htm) · [conditions](https://www.nps.gov/ever/planyourvisit/conditions.htm)
- **Grand Canyon**: [fees](https://www.nps.gov/grca/planyourvisit/fees.htm) (contains the "no timed entry" statement) · [conditions](https://www.nps.gov/grca/planyourvisit/conditions.htm)
- **Glacier**: [fees](https://www.nps.gov/glac/planyourvisit/fees.htm) (contains the 2026 no-reservations statement) · [reservations](https://www.nps.gov/glac/planyourvisit/reservations.htm) · [conditions](https://www.nps.gov/glac/planyourvisit/conditions.htm)
- **Olympic**: [fees](https://www.nps.gov/olym/planyourvisit/fees.htm) · [plan your visit](https://www.nps.gov/olym/planyourvisit/index.htm) (entry-reservation statement) · [conditions](https://www.nps.gov/olym/planyourvisit/conditions.htm)
- **Big Bend**: [fees](https://www.nps.gov/bibe/planyourvisit/fees.htm) (contains the no-reservations statement) · [conditions](https://www.nps.gov/bibe/planyourvisit/conditions.htm)
- **Joshua Tree**: [fees](https://www.nps.gov/jotr/planyourvisit/fees.htm) · [permits & reservations](https://www.nps.gov/jotr/planyourvisit/permitsandreservations.htm) · [conditions](https://www.nps.gov/jotr/planyourvisit/conditions.htm)
- **Yosemite**: [fees](https://www.nps.gov/yose/planyourvisit/fees.htm) · [entrance reservations](https://www.nps.gov/yose/planyourvisit/reservations.htm) (2026 discontinuation announcement) · [conditions](https://www.nps.gov/yose/planyourvisit/conditions.htm)
- **Kings Canyon/SEKI**: [fees](https://www.nps.gov/seki/planyourvisit/fees.htm) · [permits & reservations](https://www.nps.gov/seki/planyourvisit/permits.htm) · [conditions](https://www.nps.gov/seki/planyourvisit/conditions.htm)

**Caveats worth noting:**
- Fee ranges like "$15–$35" on some fees pages span motorcycle/per-person tiers; the figures above are specifically the **private-vehicle** rate in every case.
- Glacier and Yosemite's no-reservation status is a recent policy change framed as applying "for 2026" — worth rechecking close to a travel date, as these programs have toggled year to year.
- Everglades has a stale legacy page showing an outdated $10 fee; the current, internally consistent fees page confirms $35.
```

注目すべき形は、すべての `[delegate ->]` 行が小さなメッセージであり、すべての `[report <-]` 行が要約された summary であることです。これらの report を生み出した何 MB もの検索結果や取得済みページは、coordinator の context を一度も横切っていません。この分離こそがコストの話のすべてです。公平に価格を出すために、次のセクションでは現実的な代替案を実行し、そのうえで両方を計測します。

## 3. control を実行する: 1 つの frontier agent、同じ検証基準

このパターンなしでは、どれくらいのコストになるでしょうか。現実的な代替案は、同じ 2 つの Web ツールを持つ 1 つの frontier agent です。この比較を公平にも無意味にもする微妙な点があります。**solo agent に同じ検証基準を課さなければなりません。** 自分の判断に任せると、frontier モデルは経済的に動きます。事実ごとに 1 つの source だけを読み、安く済ませます。しかしそれは、同じ作業を違う価格で行ったものではなく、より低い厳密さの別プロダクトです。そのため、下の solo prompt は team がすでに行っていることを要求します。すべての事実を 2 回の独立した fetch で検証し、矛盾は再確認して明示する、ということです。

同じ質問を、静かな stream で実行します。

```python
solo = client.beta.agents.create(
    name="solo-researcher",
    model=COORDINATOR_MODEL,
    tools=[
        {
            "type": "agent_toolset_20260401",
            "default_config": {"enabled": False},
            "configs": [
                {"name": "web_search", "enabled": True},
                {"name": "web_fetch", "enabled": True},
            ],
        }
    ],
    system=(
        "You research hard web questions with audit-grade rigor. Use "
        "web_search and web_fetch. For EVERY fact you report, verify it "
        "from at least two independent fetches (the authoritative page "
        "plus one corroborating source), and re-fetch when two sources "
        "disagree. Never carry a fact forward on one source or from "
        "memory. In your answer, give each fact with both source URLs, "
        "and explicitly flag any fact where sources conflicted. Before "
        "finishing, audit your own answer: list each claim and check it "
        "has two cited sources."
    ),
    betas=BETAS,
)

t_solo = time.monotonic()
solo_session = client.beta.sessions.create(agent=solo.id, environment_id=env.id, betas=BETAS)
client.beta.sessions.events.send(
    solo_session.id,
    betas=BETAS,
    events=[{"type": "user.message", "content": [{"type": "text", "text": QUESTION}]}],
)

solo_answer = ""
with client.beta.sessions.events.stream(solo_session.id, betas=BETAS) as stream:
    for ev in stream:
        match ev.type:
            case "agent.message":
                if text := text_of(ev.content).strip():
                    solo_answer = text
            case "session.status_idle":
                break

print(f"[solo finished in {time.monotonic() - t_solo:.0f}s]")
print(clip(solo_answer, 300))
```

```text
[solo finished in 608s]
All facts verified. Here are the results, with every fee and reservation status confirmed against at least two official nps.gov pages.

## Which parks made the list

By official NPS acreage, the ten largest national parks in the contiguous U.S. are: Death Valley, Yellowstone, Everglades, Grand Canyo...
```

## 4. 両方の実行を計測し、価格を出す

コスト帰属は API に組み込まれています。すべての session thread は型付きの累積 `usage` を持ち、`session.usage` はチーム全体の合計です。thread を一覧し、primary thread（`parent_thread_id is None`）を coordinator とみなし、child thread を worker とみなします。solo session には単に child thread がありません。

（request ごとの詳細が必要な場合は、それぞれの thread の event feed にあります。session-level feed が運ぶ `span.model_request_end` event は primary thread のものだけです。）

価格は執筆時点の [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) から取っています（Sonnet 5 は導入価格を表示しています）。設定が必要なのは input と output のレートだけです。5 分 cache writes は input rate の 1.25 倍、1 時間 writes は 2 倍、cache reads は 0.1 倍で請求されます。そして `/v1/models` は capability を報告しますが価格は報告しないため、モデルごとの 2 つの数値はコード内に置きます。

```python
# $ / MTok input and output from the pricing page. Sonnet 5 is its
# introductory rate ($2/$10 through Aug 31, 2026; standard $3/$15
# after — update these numbers then).
PRICES = {
    "claude-fable-5": {"input": 10.0, "output": 50.0},
    "claude-sonnet-5": {"input": 2.0, "output": 10.0},
}


def total_input(u):
    cache = u.cache_creation  # None on threads with no cache activity
    return (
        u.input_tokens
        + u.cache_read_input_tokens
        + (cache.ephemeral_5m_input_tokens if cache else 0)
        + (cache.ephemeral_1h_input_tokens if cache else 0)
    )


def cost(u, model):
    p = PRICES[model]
    cache = u.cache_creation
    return (
        u.input_tokens * p["input"]
        + (cache.ephemeral_5m_input_tokens if cache else 0) * p["input"] * 1.25
        + (cache.ephemeral_1h_input_tokens if cache else 0) * p["input"] * 2.0
        + u.cache_read_input_tokens * p["input"] * 0.1
        + u.output_tokens * p["output"]
    ) / 1e6


def report(session_id, primary_model, worker_model):
    threads = list(client.beta.sessions.threads.list(session_id, betas=BETAS))
    primary = next(t.usage for t in threads if t.parent_thread_id is None)
    workers = [t.usage for t in threads if t.parent_thread_id is not None]
    workers_in = sum(total_input(u) for u in workers)
    total = cost(primary, primary_model) + sum(cost(u, worker_model) for u in workers)
    print(
        f"  primary thread ({primary_model}): {total_input(primary):>9,} in / {primary.output_tokens:>6,} out"
    )
    if workers:
        print(
            f"  {len(workers)} worker(s) ({worker_model}): {workers_in:>9,} in / {sum(u.output_tokens for u in workers):>6,} out"
        )
        print(f"  workers' share of input: {workers_in / (workers_in + total_input(primary)):.0%}")
    print(f"  total cost: ${total:.2f}")
    return total


print("split team (fable coordinator + sonnet workers):")
split_cost = report(session.id, COORDINATOR_MODEL, WORKER_MODEL)

print("\nsolo frontier agent:")
solo_cost = report(solo_session.id, COORDINATOR_MODEL, COORDINATOR_MODEL)

# The counterfactual that isolates the rate split: this run's team
# workload with every token billed at the frontier rate.
threads = list(client.beta.sessions.threads.list(session.id, betas=BETAS))
frontier_team_cost = sum(cost(t.usage, COORDINATOR_MODEL) for t in threads)

print(f"\nsolo / split cost ratio on this pair of runs: {solo_cost / split_cost:.1f}x")
print(f"the split team's workload at all-frontier rates: ${frontier_team_cost:.2f}")
```

```text
split team (fable coordinator + sonnet workers):
```

```text
  primary thread (claude-fable-5):   169,391 in /  6,484 out
  10 worker(s) (claude-sonnet-5):   908,392 in / 34,164 out
  workers' share of input: 84%
  total cost: $1.61

solo frontier agent:
  primary thread (claude-fable-5): 1,259,624 in / 38,479 out
  total cost: $4.00
```

```text

solo / split cost ratio on this pair of runs: 2.5x
the split team's workload at all-frontier rates: $5.06
```

2 つの実行は、ほぼ同じ量を読みました。検証基準をそろえることの意味はそこにあります。違うのは、読み取りがどのレートで請求されたか、そして仕事の形です。チームでは 20 個の lookup が安価なレートの並列 worker thread として走りました。一方、solo agent はそれらを 1 つの frontier 価格の context の中で直列に処理しました。著者らの実行では、その結果としてチームはおよそ 2.5 倍安く、3 倍速くなり、チームの input token の 84-98% が worker レートで請求されました。token 量は実行ごとに変わるため、表示された単一の比率は 1 つのサンプルとして扱ってください。安定しているのは構造です。

4 つの正直な caveat があります。いずれも、このノートブックを作る中で観察したものです。

- **比較の厳密さをそろえる。** solo frontier agent を自分の判断に任せると、はるかに少なく読みます（事実ごとに 1 つの source）。そのため team より安くなりますが、それは別の、より低い厳密さのプロダクトです。検証基準を固定したとき、分割のコスト上の勝ちは本物です。
- **委譲には floor cost がある。** 各 worker thread には固定の setup overhead があります。同じ仕事をより多く、より狭い brief に分割すると、請求額は下がるどころか上がりました。brief の粒度には最適点があります。
- **検証基準がカバーするのは、その中に入れたものだけである。** commit された実行では、両方式とも 20 個すべての事実を nps.gov で検証しました。そして両方式とも、公園のリストをモデルの記憶から作ったため、本来 Great Smoky Mountains が入る #10 の枠に Kings Canyon を入れてしまいました（Kings Canyon は面積で #12 です）。事実は audit されましたが、question decomposition は audit されていませんでした。前提が重要なら、もう 1 つ delegation を使って worker にそれを検証させてください。
- **coordinator が知るのは、あなたが伝えたことだけである。** サーバーは worker の prompt を coordinator に見せません（section 1 を参照）。したがって、この経済性は、coordinator の prompt で worker の挙動を正確に説明しているかにも依存します。

どのような場合に分割が割に合わないのでしょうか。狭い質問では、arbitrage するほどの読み取りがありません。coordinator が自分の知識だけで答える場合（delegation なし）、frontier の round-trip を無駄に支払ったことになります。`[spawn]` 行がない実行に注意してください。また、生の素材そのものに frontier の判断が必要な task（事実探索ではなく、微妙なドキュメント分析など）では、安価な読み手がまさに重要だった部分を要約で落としてしまうことがあります。

## まとめ

このガイドでは、multi-agent team の中で最も安価で実用的な形を作り、それが何をもたらすかを計測しました。

- **2 モデルのチームを構成した**。唯一の capability が `multiagent` roster である frontier coordinator と、Web ツールだけに scope された安価な worker です。
- **委譲をライブに追跡した**。session stream 上の `thread_created` / `thread_message_sent` / `thread_message_received` を使いました。
- **厳密さをそろえた solo frontier の control を実行した**。推定ではなく、実際の請求額と実際の経過時間を比較しました。
- **各 thread を計測した**。すべての session thread が持つ型付き累積 `usage` を使いました（`session.usage` はチーム全体の合計です）。

さらに進めるには:

1. scope された toolset を持つ specialist worker type を追加する。[`CMA_coordinate_specialist_team.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_coordinate_specialist_team.ipynb) は 3 役のチームと、role ごとの scoping が重要な理由を示しています
2. thread ごとの metering を本番 telemetry に入れる。thread-level usage は、session 単位だけでなく delegation ごとに支出を帰属させる方法です
3. 自分の token-heavy なワークロードで同じ分割を試す。ドキュメントレビューやログ triage は、Web リサーチと同じ read-heavy で coverage-shaped な profile を持っています

Reference: [multi-agent sessions documentation](https://platform.claude.com/docs/en/managed-agents/multi-agent).
