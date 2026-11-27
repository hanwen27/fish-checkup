// Read-only source resolver for the opt-in native COO integration test process.
// This is not installed in COO and never resolves user deployment/config files.
import { registerHooks } from 'node:module';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.COO_SOURCE_ROOT;
if (!root) throw new Error('COO_SOURCE_ROOT must name the read-only cortico source package.');
const source = resolve(root, 'src');
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('cortico/')) return next(specifier, context);
    const path = resolve(source, specifier.slice('cortico/'.length));
    const rel = relative(source, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('COO source import escaped source root.');
    return next(pathToFileURL(path).href, context);
  },
});
