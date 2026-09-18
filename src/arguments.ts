/**
 * Tool arguments the supervisor kept spelling two ways. Accept every spelling, insist on one
 * value, and name the canonical field in the error so the schema teaches itself.
 */
export function oneOf<T>(args:Record<string,unknown>,names:readonly string[],fallback?:T):T {
 const supplied=names.filter(n=>args[n]!==undefined);
 if(supplied.length===0){if(fallback!==undefined)return fallback;throw new Error(`ARGUMENT_MISSING: provide ${names[0]}${names.length>1?` (alias ${names.slice(1).join(', ')})`:''}`);}
 const values=new Set(supplied.map(n=>JSON.stringify(args[n])));
 if(values.size>1)throw new Error(`ARGUMENT_CONFLICT: ${supplied.join(' and ')} disagree; supply one of them`);
 return args[supplied[0]] as T;
}
