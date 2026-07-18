import importedRoutes from './imported-routes';
import { createRouter } from 'vue-router';

const section = 'teams';
const routes = [
  { path: '/literal', name: 'literal', component: 'LiteralView' },
  ...importedRoutes,
  { path: section, name: 'computed', component: 'ComputedView' },
  { path: `/teams/${section}`, name: 'interpolated', component: 'TeamView' },
  { path: '/users/' + section, name: 'prefixed-path', component: 'UserView' },
  {
    path: '/literal-with-dynamics',
    name: 'literal-' + section,
    component: 'LiteralView',
    alias: '/alias/' + section,
  },
  { path: '/conflict', name: 'conflict-first', component: 'FirstView' },
  { path: '/conflict', name: 'conflict-second', component: 'SecondView' },
];

createRouter({ routes });
createRouter({ routes: importedRoutes });
