---
source_notebook: 'https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_plan_big_execute_small.ipynb'
description: 'Unofficial Markdown conversion of the source notebook'
original_copyright: 'Copyright (c) 2023 Anthropic'
license: 'MIT License'
license_url: 'https://github.com/anthropics/claude-cookbooks/blob/main/LICENSE'
---

# Coordinator pattern: big models for planning, small models for execution

## Introduction

Most agent workloads have two very different jobs inside them: a small amount of planning and judgment, and a large amount of mechanical reading and doing. Web research is the extreme case, and it's the example this notebook uses: verifying twenty facts against their authoritative sources means pulling hundreds of thousands of tokens of web pages through a model, and at frontier rates that reading bill dominates.

The coordinator pattern splits the two workloads. A frontier model plans the research and synthesizes the answer, but it never touches a raw web page — cheap workers do all the reading in their own parallel context windows and report back distilled findings. This notebook measures the split honestly: it runs the realistic alternative — one frontier agent with the same tools, held to the same verification standard — on the same question, and compares real bills and real wall-clock. On the authors' runs both arms read about the same amount, and the team came out roughly 2.5x cheaper and 3x faster, with 84-98% of its input tokens billed at the worker rate.

**By the end of this cookbook, you'll be able to:**

- Configure a two-model team with the `multiagent` coordinator field: a frontier coordinator and cheap search workers
- Follow a delegation live through the session event stream (`thread_created`, `thread_message_sent`, `thread_message_received`)
- Run a rigor-matched solo-frontier control and compare real bills
- Meter each thread with the typed per-thread cumulative `usage`

The same economics apply to any workload where a cheap model can do the token-heavy leg: document review, log analysis, codebase sweeps.

![Architecture of the coordinator pattern: the user's question goes to a frontier-model coordinator with no tools of its own; it sends one brief per park to parallel small-model search workers and gets distilled findings back; only the workers touch the open web, via web search and page fetch; the coordinator synthesizes the final answer.](https://raw.githubusercontent.com/anthropics/claude-cookbooks/main/managed_agents/example_data/plan_big_execute_small/architecture_diagram.png)

## Prerequisites

Before following this guide, ensure you have:

**Required Knowledge:**

- Python fundamentals
- Familiarity with the Managed Agents basics — agents, environments, sessions, and the streaming event loop ([`CMA_iterate_fix_failing_tests.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_iterate_fix_failing_tests.ipynb) introduces all of them)

**Required Tools:**

- Python 3.11 or higher
- Anthropic API key ([get one here](https://console.anthropic.com)) with access to the Managed Agents beta

If you haven't seen the `multiagent` field before, [`CMA_coordinate_specialist_team.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_coordinate_specialist_team.ipynb) introduces it with a heterogeneous specialist team. This notebook uses the simplest possible team — one worker type — because the point here is the cost structure, not the team design.

## Setup

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

## 1. The team: cheap readers, expensive thinker

Two agent definitions make the whole team.

The **worker** — in the docs' terms, a subagent the coordinator can spawn from its roster — is an ordinary agent: a model, a toolset scoped down to `web_search` + `web_fetch`, and a system prompt. Each worker instance researches one focused sub-question in its own session thread, so the giant web pages it reads never enter anyone else's context.

The **coordinator** has no tools of its own — only a `multiagent` roster naming the worker. That one field is what makes it a coordinator: the server automatically gives it `create_agent`, `send_to_agent`, `wait_for_agents`, and `list_agents`, and workers get `submit_result` and `send_to_parent` the same way. You never define any of those tools.

Two things to know about this relationship. First, the roster is snapshotted when the coordinator is created or updated — if you change the worker's definition, update or recreate the coordinator. Second, and less obvious: **the coordinator can't see anything about its roster agents** — not their prompts, not their names, not their descriptions. Its `create_agent` tool takes a bare agent name and task string. Everything the coordinator believes about its workers comes from its own system prompt, so keep that description and the workers' actual prompts in agreement — nothing on the server enforces it. (With a single-agent roster, any requested name resolves to the one worker; with several worker types, name them explicitly in the coordinator's prompt.)

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

## 2. Run a research question

Create an environment and a session for the coordinator, send the question as a `user.message`, and stream. The session-level stream is the coordinator's primary thread — a condensed view of the whole run. Worker threads show up in it as delegation traffic: `session.thread_created` when a worker is spawned, `agent.thread_message_sent` when the coordinator hands one a sub-question, and `agent.thread_message_received` when the findings come back.

The question is a coverage task — twenty facts (10 parks x 2 attributes), each of which must be verified against a specific authoritative source. Coverage questions are where the pattern shines, because the reading is mandatory: nobody gets to answer from memory, so the only question is what rate the reading bills at and whether it happens in parallel. (Discovery questions — find one answer hiding in a big search space, in the style of benchmarks like [BrowseComp](https://arxiv.org/abs/2504.12516) — reward a frontier model's search intuition more, and the gap narrows.)

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

The shape to notice: every `[delegate ->]` line is a small message, and every `[report <-]` line is a distilled summary. The megabytes of search results and fetched pages that produced those reports never crossed the coordinator's context. That separation is the entire cost story. To price it fairly, the next section runs the realistic alternative, then we meter both.

## 3. Run the control: one frontier agent, same verification standard

What would this cost without the pattern? The realistic alternative is a single frontier agent with the same two web tools. One subtlety makes this comparison fair or worthless: **the solo agent must be held to the same verification standard.** Left to its own judgment, a frontier model is economical — it reads a single source per fact and comes in cheap, but that's a lower-rigor product, not the same work at a different price. So the solo prompt below demands what the team already does: every fact verified from two independent fetches, conflicts re-checked and flagged.

Same question, quiet stream.

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

## 4. Meter and price both runs

Cost attribution is built into the API: every session thread carries a typed cumulative `usage`, and `session.usage` totals the whole team. List the threads, take the primary thread (`parent_thread_id is None`) as the coordinator, and the child threads are the workers — the solo session simply has no child threads.

(If you ever need per-request detail instead, it's in each thread's own event feed — the session-level feed only carries the primary thread's `span.model_request_end` events.)

Prices come from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) at time of writing (Sonnet 5 shows its introductory rate). Only input and output rates need configuring: 5-minute cache writes bill at 1.25x the input rate, 1-hour writes at 2x, cache reads at 0.1x — and `/v1/models` reports capabilities but not pricing, so the two numbers per model live in your code.

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

The two runs did nearly the same reading — that's the point of matching the verification standard. What differs is the rate the reading billed at and the shape of the work: the team's twenty lookups ran as parallel worker threads at the cheap rate, while the solo agent ground through them serially in one frontier-priced context. On the authors' runs that came out to the team being roughly 2.5x cheaper and 3x faster, with 84-98% of the team's input tokens billed at the worker rate. Token volumes vary run to run, so treat any single printed ratio as one sample; the structure is the stable part.

Four honest caveats, all observed while building this notebook:

- **Hold the comparison to matched rigor.** A solo frontier agent left to its own judgment reads far less (one source per fact) and comes in cheaper than the team — but that's a different, lower-rigor product. The split's cost win is real when the verification standard is fixed.
- **Delegation has a floor cost.** Each worker thread pays a fixed setup overhead. Splitting the same work into more, narrower briefs raised our bill instead of lowering it — brief granularity has an optimum.
- **The verification standard only covers what you put in it.** Both arms in the committed run verified all twenty facts against nps.gov — and both built their list of parks from model memory, which put Kings Canyon in the #10 slot that actually belongs to Great Smoky Mountains (Kings Canyon is #12 by area). The facts were audited; the question decomposition wasn't. If the premise matters, spend one more delegation making a worker verify it.
- **The coordinator only knows what you tell it.** Nothing on the server shows it the workers' prompts (see section 1), so the economics also depend on you describing the workers' behavior accurately in the coordinator's prompt.

When does the split _not_ pay? On narrow questions there's too little reading to arbitrage. If the coordinator answers from its own knowledge (no delegation), you paid a frontier round-trip for nothing — watch for runs with no `[spawn]` lines. And if the task needs frontier judgment on the raw material itself (subtle document analysis rather than fact-finding), a cheap reader may summarize away exactly what mattered.

## Recap

In this guide you built the cheapest useful shape of a multi-agent team and measured what it buys:

- **Configured a two-model team** — a frontier coordinator whose only capability is its `multiagent` roster, and a cheap worker scoped to the web tools
- **Followed the delegation live** through `thread_created` / `thread_message_sent` / `thread_message_received` on the session stream
- **Ran a rigor-matched solo-frontier control** and compared real bills and real wall-clock, not estimates
- **Metered each thread** with the typed cumulative `usage` every session thread carries (`session.usage` is the whole-team total)

To take this further:

1. Add specialist worker types with scoped toolsets — [`CMA_coordinate_specialist_team.ipynb`](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_coordinate_specialist_team.ipynb) shows a three-role team and why per-role scoping matters
2. Put the per-thread metering into your production telemetry: the thread-level usage is how you attribute spend per delegation, not just per session
3. Try the same split on your own token-heavy workload — document review and log triage have the same read-heavy, coverage-shaped profile as web research

Reference: [multi-agent sessions documentation](https://platform.claude.com/docs/en/managed-agents/multi-agent).
