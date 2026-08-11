# Super

A single-operator, browser-based coding agent that runs entirely on Cloudflare. The operator chats with a model, the model picks and applies Skills, and work is carried out by executing commands against a virtual filesystem.

The product is named **Super**. "Harness" remains the term for what it *is* — the system described below — but the name shown to a human is Super.

## Language

### The product

**Harness**:
The whole system — chat interface, agent loop, skill loading, and execution. Not a chatbot: it is defined by the fact that the model can act, not merely answer.
_Avoid_: App, platform, assistant, wrapper

**Operator**:
The human logged into the Harness. Currently exactly one (Naveen). Distinct from the model, which acts on the Operator's behalf.
_Avoid_: User, account, customer

**Conversation**:
One continuous chat thread between the Operator and the Harness, containing an ordered series of Turns.
_Avoid_: Session, thread, chat

**Turn**:
One Operator message plus everything the Harness does in response — model calls, skill loads, and command executions — up to the point it hands control back.
_Avoid_: Exchange, round, step

**Workspace**:
A named, persistent filesystem that many Conversations may attach to. The durable unit of work; Conversations are disposable, the Workspace is not.
_Avoid_: Project, sandbox, environment, repo

**Binding**:
The link between a Workspace and a GitHub repository, established by cloning it with real git. Carries genuine history, branches and diffs. HTTPS only.
_Avoid_: Clone, checkout, sync, integration

**Heavy Mode**:
A future execution backend with a real Linux userland, able to run native binaries. Named now so its absence can be stated precisely; not built.
_Avoid_: Container mode, full mode, pro mode

### Skills

**Skill**:
A folder in the open Agent Skills format: a `SKILL.md` with `name` and `description` frontmatter plus body instructions, optionally bundled with scripts and reference files. The unit of teachable capability.
_Avoid_: Plugin, extension, tool, prompt template

**Preloaded Skill**:
A Skill shipped with the Harness and available without any install step.
_Avoid_: Built-in, default skill, core skill

**Installed Skill**:
A Skill the Operator added at runtime from a GitHub source, stored alongside Preloaded Skills and indistinguishable from them once installed.
_Avoid_: Custom skill, third-party skill, user skill

**Skill Manifest**:
The `name` and `description` pair extracted from a Skill's frontmatter. Every Skill's Manifest is always in the model's context; the body is loaded only when that Skill is chosen.
_Avoid_: Index, catalog entry, metadata

### Models

**Model Profile**:
A named, swappable configuration of one LLM endpoint — base URL, credential reference, model identifier, and price. Adding a provider means adding a Model Profile, never changing code.
_Avoid_: Provider, backend, model config, LLM

**Default Profile**:
The Model Profile used when the Operator expresses no preference. Chosen for cost, not capability.
_Avoid_: Fallback, base model

**Council**:
An opt-in mode where several Model Profiles answer the same prompt independently and in parallel. Advisory by definition: a Council produces opinions, never changes.
_Avoid_: Ensemble, panel, committee, swarm

**Council Member**:
One Model Profile participating in a Council. Holds read-only tools and cannot write a file or execute a command.
_Avoid_: Voter, juror, agent

**Chair**:
The single Model Profile that synthesises Council Members' answers into one response. Deliberately a cheap Profile.
_Avoid_: Judge, arbiter, referee, synthesiser
