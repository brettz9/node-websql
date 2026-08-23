import ashNazg from 'eslint-config-ash-nazg';

export default [
  {
    ignores: [
      'coverage',
      'dist'
    ]
  },
  ...ashNazg(['sauron', 'node'])
];
