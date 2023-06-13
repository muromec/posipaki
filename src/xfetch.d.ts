declare module 'pspki/src/xfetch.js';

declare type FetchState<DataType> = {
  data: DataType;
  code: 'pending' | 'loading' | 'ok' | 'error';
};

declare type FetchArgs = {
  url: URL,
};
