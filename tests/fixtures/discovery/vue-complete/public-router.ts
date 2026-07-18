import { createRouter } from 'vue-router';

export default createRouter({
  routes: [
    {
      path: `/about`,
      name: 'about',
      component: 'AboutView',
      meta: { public: true },
    },
    {
      path: '/files/:pathMatch(.*)*',
      name: 'files',
      component: 'FilesView',
      alias: `/assets/:pathMatch(.*)*`,
    },
  ],
});
