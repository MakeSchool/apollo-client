# Apollo Client with `@defer` support

This branch of `apollo-client` has `@defer` support on top of the latest master, along with a fix for https://github.com/apollographql/apollo-client/issues/4484.

As soon as I can make https://github.com/rmosolgo/graphql_defer_example work without this fork, I'll stop maintaining it.

### Installing

This repo contains several TypeScript libraries which must be copied locally, "compiled", then installed with yarn.

#### Copy & Compile

```sh
$ git submodule add git@github.com:rmosolgo/apollo-client.git
$ # installs this fork into `./apollo-client`
$ cd apollo-client
$ npm install
$ # installs dependencies and compiles typescript
```

#### Installing from local files

Add to your `package.json`, for example, `apollo-boost`:

```js
  "apollo-boost": "file:./path/to/apollo-client/packages/apollo-boost",
```

(If you need specific other packages, do the same thing for those other packages.)

Then, `yarn install`.
