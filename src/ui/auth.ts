/** Claude's login failures, as older and current sessions report them in the conversation. */
export function loginError(text: string): boolean {
  return /failed to authenticate:.*oauth|oauth (?:session|token).*(?:expired|refresh)|(?:not logged in|invalid.*token).*please run \/login/i.test(text);
}
