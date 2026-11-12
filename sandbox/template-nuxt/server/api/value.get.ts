export default defineEventHandler(event => ({ value: String(getQuery(event).value ?? 'initial') }));
