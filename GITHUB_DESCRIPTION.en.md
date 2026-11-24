# Fish Checkup: Practical Runtime Insights, Playful Personality Discoveries

A local World extension for Coopanion. It offers two separate views: one helps you understand runtime health, and the other collects small, playful observations about your companion.

## Runtime health: what is working, what may need a closer look

Using existing runtime records, the report reviews stability, response time, cache, context configuration, handoffs and memory. Scores appear alongside trends and supporting evidence to make the numbers easier to understand. The extension reports findings; it does not automatically change settings.

## Playful profile: discover her little quirks

After the companion completes a self-assessment, behavioural signals help create a nickname, short labels, recent observations and a playful profile card. Optional light quizzes and creative prompts add a little room for exploration. Compare how she describes herself with what her everyday patterns suggest, then share the discoveries you find fun.

This is a companion-oriented playful profile, not a clinical or standardized personality assessment. It does not judge a companion as good or bad. Runtime health and personality remain separate, so a technical hiccup is not framed as a personality issue.

## Trial installation

1. Download the [friends-and-community trial ZIP](./self-checkup-0.2.5-群友试用版-新封面.zip) and extract it.
2. In Coopanion, open **Advanced Mode → World Extensions → Extension Market → Manual Install → Install from Local Directory**, then select the extracted `self-checkup` folder.
3. Restart the process when prompted, then enable **Checkup Report** in **World Overview**.
4. Local-directory installation links to the extracted folder; keep it in place while testing.

The trial build is version 0.2.5. The project's first formal release is planned to start at **1.0.0**. The trial includes source, built UI, assets and tests; 203 automated tests and the World assembly smoke test passed.

## Data notes

The extension reads Coopanion's local runtime records, configuration, workspace memory and handoff data to prepare reports. It stores results under its own `dataDir/self-checkup/results.json`; personality quiz answers are used to produce and save the report. The AI profile card is optional; model use depends on the flow chosen by the user and host capabilities. Check screenshots for personal information before sharing, and remove chat contents, memory files, configuration and credentials from public feedback.

For installation issues, reproduction steps or suggestions, open a repository issue. Include the Coopanion and extension versions and a minimal reproduction, with personal information removed.
