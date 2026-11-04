export function cliProfileAuthStateLabel(state){
  if (!state) return 'not checked';
  if (state.message) return state.message;
  if (state.error) return 'error';
  if (state.kind === 'check' && state.result) {
    if (state.result.authenticated === true && state.result.modelsAvailable === false) return 'authenticated · catalog unavailable';
    if (state.result.authenticated === true) return 'authenticated';
    if (state.result.status === 'not-authenticated') return 'not authenticated';
    return state.result.status || 'checked';
  }
  if (state.job) return state.job.status;
  return state.status || 'unknown';
}
