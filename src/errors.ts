/**
 * Failures this server distinguishes by code, so callers branch on `code` rather than on
 * message text. The message keeps the `CODE: detail` shape the tools have always returned.
 */
export class CodedError extends Error {
 constructor(readonly code:string,detail?:string){super(detail?`${code}: ${detail}`:code);this.name='CodedError';}
}
/** The code of any error: an explicit `code`, else the leading `CODE` token of a `CODE: detail` message. */
export function codeOf(e:unknown):string|undefined {
 if(e instanceof CodedError)return e.code;
 if(e instanceof Error)return /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(e.message)?.[1];
 return undefined;
}
export function hasCode(e:unknown,...codes:string[]){const code=codeOf(e);return code!==undefined&&codes.includes(code);}
