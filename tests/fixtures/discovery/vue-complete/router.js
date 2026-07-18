import { createRouter } from 'vue-router';

// Sentinel parses this literal as data. It never imports or evaluates this file.
const routes = [
  {
    path: '/admin',
    name: "admin",
    component: `AdminLayout`,
    meta: {
      requiresAuth: true,
      roles: ['admin', 'operator'],
    },
    alias: ['/control', '/control'],
    children: [
      {
        path: 'users/:id',
        name: 'admin-user',
        component: "UserView",
        alias: ['members/:id', '/users/:id', 'members/:id'],
      },
      {
        path: 'reports/:slug?',
        name: `admin-report`,
        component: 'ReportView',
      },
      {
        path: '/login',
        name: 'login',
        component: 'LoginView',
        meta: { requiresAuth: false },
      },
    ],
  },
  {
    path: '/landing',
    name: 'landing-shell',
    component: 'LandingShell',
    alias: '/welcome',
    meta: { public: true },
    children: [
      {
        path: '',
        name: 'landing',
        component: 'LandingView',
        alias: '/home',
      },
    ],
  },
];

export default createRouter({ routes });
