import importedRoutes from './imported-routes';
import { createRouter } from 'vue-router';

const section = 'teams';
const routes = [
  { path: '/literal', name: 'literal', component: 'LiteralView' },
  ...importedRoutes,
  { path: section, name: 'computed', component: 'ComputedView' },
  { path: `/teams/${section}`, name: 'interpolated', component: 'TeamView' },
];

createRouter({ routes });
createRouter({ routes: importedRoutes });
