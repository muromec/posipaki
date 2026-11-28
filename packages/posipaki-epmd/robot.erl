%% The Erlang side of the demo: a node that answers by name, and a watch of a posipaki node's process.
%%
%%   erlc robot.erl
%%   erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% `hello_echo` answers <<"hello ", Text/binary>>.
%%
%%   POSIPAKI_NODE=posipaki@192.168.88.27 \
%%     erl -name watcher@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:watch(), halt().'
%%
%% -name rather than -sname: a short-name node refuses to connect to a name whose host is an address, and the posipaki
%% side is addressed by one.
-module(robot).
-export([start/0, watch/0]).

start() ->
    register(hello_echo, spawn(fun loop/0)),
    io:format("hello_echo registered on ~p~n", [node()]),
    receive stop -> ok end.

%% Answers text with hello and the text back, and anything else with what it is not.
loop() ->
    receive
        {From, Text} when is_binary(Text) -> From ! hello_echo(Text), loop();
        {From, _Other} -> From ! <<"not a binary">>, loop()
    end.

%% The answer to a text: hello, and the same text after it.
hello_echo(Text) ->
    <<"hello ", Text/binary>>.

%% Watches the name POSIPAKI_NAME (default `posipaki`) at the node POSIPAKI_NODE names: monitors the name, asks the
%% process itself `whois` for the pid it answers at, monitors that pid, and only then tells it to exit.
watch() ->
    Node = node_to_watch(),
    Name = list_to_atom(text_of("POSIPAKI_NAME", "posipaki")),
    NameMonitor = monitor(process, {Name, Node}),
    io:format("watching ~p at ~p (~p)~n", [Name, Node, NameMonitor]),
    {Name, Node} ! {whois, self()},
    Deadline = erlang:monotonic_time(millisecond) + 5000,
    await(Name, [NameMonitor], Deadline).

%% Waits until no monitor is owed an answer. The `whois` answer adds the pid's monitor and asks that pid to exit, so the
%% exit is asked with both monitors in place. A term that is neither stays in the mailbox.
await(_Name, [], _Deadline) ->
    ok;
await(Name, Pending, Deadline) ->
    receive
        {whois, Pid} when is_pid(Pid) ->
            PidMonitor = monitor(process, Pid),
            io:format("whois ~p: ~p (~p)~n", [Name, Pid, PidMonitor]),
            io:format("asking ~p to exit~n", [Pid]),
            Pid ! <<"exit">>,
            await(Name, [PidMonitor | Pending], Deadline);
        {'DOWN', Monitor, process, Watched, Reason} ->
            io:format("down ~p ~p ~p~n", [Monitor, Watched, Reason]),
            await(Name, Pending -- [Monitor], Deadline)
    after max(0, Deadline - erlang:monotonic_time(millisecond)) ->
            io:format("no answer for ~p of the monitors~n", [length(Pending)])
    end.

%% POSIPAKI_NODE as a node, or a sentence that stops the run.
node_to_watch() ->
    case os:getenv("POSIPAKI_NODE") of
        false ->
            io:format("watch needs POSIPAKI_NODE, e.g. posipaki@192.168.88.27~n", []),
            halt(1);
        Text ->
            list_to_atom(Text)
    end.

%% An environment variable's text, or the default when it is unset.
text_of(Name, Default) ->
    case os:getenv(Name) of
        false -> Default;
        Text -> Text
    end.
