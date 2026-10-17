import type { Runtime } from '../runtime.js';
import notesLists from './notes-lists.js';
import documents from './documents.js';
import google from './google/index.js';
import skills from './skills.js';
import reminders from './reminders.js';
import workflows from './workflows.js';
import developer from './extension-developer.js';
import telegram from './telegram.js';
import web from './web.js';
import research from './research.js';
import planning from './planning.js';
import images from './images.js';
import family from './family.js';

export function registerFeatures(core: Runtime): void {
  const extensions = core.extensions;
  extensions.registerBuiltin('notes-lists', notesLists);
  extensions.registerBuiltin('documents', documents);
  extensions.registerBuiltin('google', api => google(api, core), ['gmail']);
  extensions.registerBuiltin('skills', api => skills(api, core));
  extensions.registerBuiltin('reminders', reminders);
  extensions.registerBuiltin('workflows', api => workflows(api, core));
  extensions.registerBuiltin('extension-developer', developer);
  extensions.registerBuiltin('telegram', api => telegram(api, core));
  extensions.registerBuiltin('web', web);
  extensions.registerBuiltin('research', research);
  extensions.registerBuiltin('planning', planning);
  extensions.registerBuiltin('images', images);
  extensions.registerBuiltin('family', family);
}
