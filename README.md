# Pharmaco: Conversational Pharmacovigilance and Automated Adverse Drug Reaction Intake System

Pharmaco is an open-source clinical informatics platform designed to lower barriers to spontaneous Adverse Drug Reaction (ADR) reporting. Operating through a multi-agent architectural framework, the system captures natural-language patient disclosures across regional Indian languages, extracts standardized clinical entities, conducts rule-assisted safety triage aligned with ICH E2A guidelines, maps reported terms to candidate MedDRA terminology, and synthesizes individual case safety reports (ICSR) for regulatory review.

Inference is executed via **Nebius Token Factory**, evaluating the open-weights **NVIDIA Nemotron 3 Super** foundation model (`nvidia/nemotron-3-super-120b-a12b`).

---

## Abstract and Clinical Motivation

Spontaneous reporting remains the foundation of post-marketing drug surveillance (pharmacovigilance). However, systemic underreporting impairs signal detection globally—an issue accentuated in linguistically diverse regions such as India. Standard reporting instruments (e.g., CDSCO / Pharmacovigilance Programme of India Suspected Adverse Drug Reaction Reporting Forms) demand technical clinical literacy, structured chronologies, and administrative patience beyond typical layperson capabilities.

Pharmaco addresses this data bottleneck by restructuring ADR intake as an adaptive clinical consultation:
1. **Low-Friction Patient Intake:** Accepts unstructured disclosures in lay terminology across major Indian regional languages and Indian English.
2. **Context-Preserving Clinical Extraction:** Sequentially identifies active compounds, indication, dosing frequency, onset latency, and dechallenge/rechallenge dynamics.
3. **Conservative Seriousness Triage:** Categorizes reported events against explicit ICH E2A seriousness criteria with non-negotiable conservative defaults (unreported variables default to *undetermined*, preventing false-negative safety conclusions).
4. **Verifiable Terminology & Causality Staging:** Proposes candidate WHO MedDRA Preferred Terms without code fabrication and organizes temporal and pharmacological evidence under the WHO-UMC causality classification.
5. **Human-in-the-Loop Governance:** Restricts automated outputs to verifiable draft states, presenting an audit trail of verbatim patient quotations, uncertainty boundaries, and telemetry before expert validation.

---

## System Architecture

Pharmaco organizes domain tasks across five coordinated, decoupled computational agents:

```
                            [ Patient Narrative ]
                        (Free-text or transcribed audio)
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Agent 1: Conversational Dialogue  │
                     │  - Adaptive 1–2 field follow-up   │
                     │  - Negative vs. missing isolation │
                     └─────────────────┬─────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Agent 2: Clinical Entity Extract  │
                     │  - Normalization to ICSR schema   │
                     │  - Verbatim excerpt provenance    │
                     └─────────────────┬─────────────────┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  ▼                                         ▼
   ┌─────────────────────────────┐           ┌─────────────────────────────┐
   │ Agent 3: Safety Triage      │           │ Agent 4: Terminology & PV   │
   │  - 6 ICH E2A criteria       │           │  - Candidate MedDRA PT      │
   │  - Emergency alerting (112) │           │  - WHO-UMC causality bounds │
   │  - Non-serious guards       │           │  - Zero code fabrication    │
   └──────────────┬──────────────┘           └──────────────┬──────────────┘
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Agent 5: ICSR Narrative Synthesis │
                     │  - Deterministic field compiler   │
                     │  - Evidence summary generation    │
                     │  - Telemetry & provenance logs    │
                     └─────────────────┬─────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Human Regulatory Review Dashboard │
                     │  - Sign-off / revision / export   │
                     └───────────────────────────────────┘
```

### Agent Roles and Methodologies

- **Agent 1 (Conversational Intake):** Formulates single- or paired-question follow-ups targeting highest-entropy missing fields (e.g., onset latency, dechallenge outcome, co-medications). Explicitly separates unstated attributes from confirmed negative disclosures (e.g., confirming "no other medications taken" versus an omitted response).
- **Agent 2 (Entity Extraction):** Parses conversational transcripts into a structured JSON representation encompassing patient demographics, suspect drug particulars, event manifestations, chronological markers, and confounding histories. Each datum links to a verbatim transcript segment verified by an automated string-matching routine.
- **Agent 3 (ICH E2A Safety Triage):** Evaluates six international regulatory seriousness criteria: death, life-threatening event, inpatient hospitalization / prolongation, persistent disability, congenital anomaly, and other medically important conditions. In accordance with clinical risk management, lack of explicit detail maps strictly to `undetermined` or `unknown`, barring the model from classifying incomplete reports as non-serious.
- **Agent 4 (Terminology & Causality Staging):** Cross-references user descriptions against a standardized vocabulary of common adverse reaction Preferred Terms (PTs). To prevent hallucination in environments without licensed MedDRA dictionary distribution, terms are output as candidate descriptions flagged `requires_verification` with zero numerical code synthesis. Causality evidence is evaluated against WHO-UMC criteria with algorithmic upper-bound constraints (e.g., absence of dechallenge data caps the suggestion at *Possible*).
- **Agent 5 (Case Report Synthesis):** Compiles verified entities into an individual case safety report containing full regulatory provenance, execution latency, and token metrics. All records default to `draft` and cannot transition to `approved` without authenticated human clinician intervention.

---

## NVIDIA Open Source Models & Nebius Token Factory Integration

Pharmaco utilizes state-of-the-art open-weights AI models orchestrated through high-performance European AI infrastructure provided by **Nebius**:

### 1. NVIDIA Nemotron Open Source Architecture
- **Foundation Model**: `nvidia/nemotron-3-super-120b-a12b`
- **Model Role in Multi-Agent Pipeline**:
  - **Entity Extraction & Clinical Normalization**: Nemotron’s 120-billion parameter hybrid Mixture-of-Experts (MoE) architecture provides deep biomedical understanding, allowing it to accurately disambiguate brand names, generic formulations (e.g., Augmentin vs. amoxicillin/clavulanate), dosages, and temporal chronologies from noisy, multi-lingual patient transcripts.
  - **Structured Reasoning without Hallucinations**: Leverages low-temperature greedy decoding (`temperature: 0.1`) and structured system prompts to guarantee deterministic JSON output conforming to international ICSR schemas.
  - **Dynamic Conversation Flow**: Formulates adaptive, clinically appropriate single-field follow-up inquiries that reduce cognitive load on distressed patients.

### 2. How Nebius Token Factory Accelerated Our Workflow
- **Immediate Production Inference**: Token Factory provided an instant, OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`) with zero model weight cold-starts, bypassing days of provisioning dedicated multi-GPU clusters (such as 4x or 8x H100 nodes required to host a 120B MoE model).
- **Thinking Token Control (`enable_thinking: false`)**: Using Nebius's `chat_template_kwargs: { enable_thinking: false }`, we eliminated reasoning chain latency for schema extraction, reducing end-to-end extraction response latency from ~7.5 seconds down to ~1.2 seconds while avoiding reasoning token leakage into parsed JSON.
- **Enterprise Throughput & Concurrency**: Handled concurrent multi-agent requests—allowing extraction, safety triage, and causality assessment to run in parallel without GPU memory bottlenecks or throughput degradation.
- **Developer Experience**: Seamless drop-in integration with standard HTTP/fetch clients, built-in telemetry (tokens used, latency tracking), and predictable billing during iterative agent prototyping.

### 3. Nebius Tools & Services Utilized
- **Nebius Token Factory API Gateway**: Production model routing, token rate-limiting handling, and authentication.
- **Nebius Model Catalog**: Immediate access to the latest frontier open-source foundation models from NVIDIA.
- **Nebius Client-Side Resilience Layer (`backend/src/services/nebiusService.js`)**:
  - Exponential backoff retry logic for transient connection recovery.
  - Per-request deadline enforcement (default 60s timeout).
  - Detailed token utilization and prompt/completion telemetry logging.


---

## Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend Application** | React 18, Vite, Framer Motion, Vanilla CSS Design System |
| **Application Server** | Node.js (ES Modules), Express.js |
| **Model Inference** | Nebius Token Factory (`nvidia/nemotron-3-super-120b-a12b`) |
| **Speech Processing** | Sarvam AI Speech-to-Text API (Regional Indic Languages) |
| **Verification & Tests** | Node.js Native Test Runner (`node:test`, `node:assert/strict`) |
| **Data Persistence** | Dual-mode: Firebase Firestore (production) with in-memory persistence fallback (demonstrations) |

---

## Installation and Environment Configuration

### Prerequisites
- Node.js version 18.0.0 or higher
- npm package manager

### 1. Environment Variable Setup

Populate `backend/.env` with the necessary parameters:

```ini
# Inference Gateway Configuration
NEBIUS_API_KEY=your_nebius_api_key
NEBIUS_TOKEN_FACTORY_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_NEMOTRON_MODEL=nvidia/nemotron-3-super-120b-a12b

# Optional Telephony and Speech Services
SARVAM_API_KEY=your_sarvam_api_key

# Service Bindings
PORT=4000
FRONTEND_URL=http://localhost:5175
```

### 2. Backend Initialization

```bash
cd backend
npm install
npm start
```
*The API server binds to `http://127.0.0.1:4000`.*

### 3. Frontend Initialization

```bash
cd frontend
npm install
npm run dev
```
*The client interface initializes at `http://127.0.0.1:5175`.*

---

## Verification and Empirical Testing

The project maintains an integrated test suite covering structural schema validation, clinical triage boundaries, causality logic constraints, and live model execution over Nebius Token Factory.

```bash
cd backend

# Execute offline unit tests (schema validation, boundary checks, guard logic)
npm run test:unit

# Execute full test suite (including live Nemotron Token Factory integration)
npm test
```

### Test Suite Execution Output
```
✔ Nebius Token Factory serves the NVIDIA Nemotron model (6973ms)
✔ end-to-end ADR workflow on a synthetic patient (47160ms)
✔ assessment of an empty conversation fails cleanly (0.5ms)
✔ model failure surfaces as an error, not a fabricated report (334ms)
✔ validateExtraction rejects non-objects (0.4ms)
✔ validateExtraction coerces invalid enums/types safely (0.4ms)
✔ empty extraction is valid but flagged (0.05ms)
✔ verifyExcerpts marks excerpts not present in the conversation as unverified (0.06ms)
✔ missing information is distinct from explicit negatives (0.1ms)
✔ seriousness is never declared non-serious from missing information (0.07ms)
✔ seriousness escalates on present/possible/emergency/severe (0.04ms)
✔ causality guard rails cap the AI-suggested category (0.06ms)
✔ merge does not erase known values with later nulls (0.2ms)
✔ extractJson recovers JSON wrapped in prose / fences and rejects garbage (0.1ms)

14 passed, 0 failed
```

---

## Experimental Protocol & Demonstration Walkthrough

For reproducible validation and examination:

1. Navigate to `http://127.0.0.1:5175/report`.
2. Observe the **ADR Agent Status Panel** indicating active connection to `nvidia/nemotron-3-super-120b-a12b` via Nebius Token Factory.
3. Select **"Start synthetic patient"** to load a standardized patient trajectory (or submit manual disclosures in plain language):
   - *Disclosure 1:* "I am a 54 year old woman. I took Augmentin 625 mg twice a day for a throat infection and I got an itchy red rash on my chest and arms."
   - *Observation:* Agent 1 parses the primary variables and prompts for onset latency without interrogative redundancy.
   - *Disclosure 2:* "I started it on 12 October and the rash began on 14 October in the evening. My lips also felt swollen, so my husband took me to the emergency room. They gave me an injection and kept me overnight for observation."
   - *Observation:* Agent 3 registers the lip edema and inpatient admission, triggering immediate 112 emergency precautions.
   - *Disclosure 3:* "I stopped Augmentin on 15 October and the rash got much better within two days. I also take amlodipine 5 mg for blood pressure, and nothing else. I have no other medical problems."
4. Select **"Generate ADR report"** to execute the pipeline:
   - Evaluates ICH E2A metrics: Hospitalization marked *Present*; Life-threatening marked *Possible*; overall classified as *Serious*.
   - Proposes candidate terms (`Rash`, `Swelling face`) without synthesizing unlicensed codes.
   - Constrains WHO-UMC causality bounds using recorded dechallenge timing.
5. Inspect the report, verify verbatim quote citations, export via **"Download report JSON"**, and test human review approval flows.

---

## Regulatory and Clinical Governance

1. **Non-Diagnostic Scope:** Pharmaco acts strictly as an intake documentation and decision-support instrument. It does not issue clinical diagnoses, prescribe drug modifications, or establish definitive pharmacological causality.
2. **Deterministic Seriousness Minimums:** In alignment with pharmacovigilance safety standards, missing data points are categorized as `undetermined` rather than `non-serious`.
3. **Terminology Integrity:** MedDRA is an international proprietary terminology maintained by the MSSO. This implementation avoids generating ungrounded numeric codes, outputting verified descriptive Preferred Terms flagged for manual auditor validation.
4. **Mandatory Human Sign-Off:** Automated processing generates draft documentation only. Formal submission requires deliberate human clinical confirmation.

---

## License

This software is released under the [Apache License, Version 2.0](LICENSE).
