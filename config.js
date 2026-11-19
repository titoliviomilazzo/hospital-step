// Deployment settings. An empty WEBHOOK_URL means rule-based parsing only (stage 5).
// Make scenario "Integration Webhooks, OpenAI" (custom webhook -> OpenAI gpt-4o-mini -> webhook
// response), connected 2026-11-19. The OpenAI key lives only in Make, never in this repository.
export const WEBHOOK_URL = 'https://hook.us2.make.com/904aunfh5larfuq2bjq8iih2bxbtl4qw';
// Make scenario 7101794 "Integration Webhooks, HTTP" (custom webhook -> GBIS getBusArrivalItemv2
// -> webhook response), connected 2026-11-19. The stop and route are fixed inside Make, and the
// data.go.kr key lives only in the Make connection (query parameter serviceKey, apis.data.go.kr only).
export const ARRIVAL_URL = 'https://hook.us2.make.com/upqrcyvgfsn1gsr1txbvetobendj9kcr';
