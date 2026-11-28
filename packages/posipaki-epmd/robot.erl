%% The other half of the proof: a node that hosts names, and answers what is sent to them.
%%
%%   erlc robot.erl
%%   erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% `robot` answers <<"hello ", Text/binary>> and `echo` answers <<"echo: ", Text/binary>>.
%%
%% `watch/0` is the other way round, and needs nothing of the posipaki side but a node name and a cookie: it monitors the
%% name that node serves, asks the process itself `whois` for the pid, monitors that too, and tells it to exit.
%%
%%   POSIPAKI_NODE=posipaki@192.168.88.27 \
%%     erl -name watcher@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:watch(), halt().'
%%
%% The node runs with -name rather than -sname: a short-name node refuses to connect to a name whose host is an
%% address, and the posipaki side of this demo is addressed by one.
-module(robot).
-export([start/0, watch/0]).

start() ->
    register(robot, spawn(fun() -> loop(fun(Text) -> <<"hello ", Text/binary>> end) end)),
    register(echo, spawn(fun() -> loop(fun(Text) -> <<"echo: ", Text/binary>> end) end)),
    io:format("robot and echo registered on ~p~n", [node()]),
    receive stop -> ok end.

loop(Reply) ->
    receive
        {From, Text} when is_binary(Text) -> From ! Reply(Text), loop(Reply);
        {From, _Other} -> From ! <<"not a binary">>, loop(Reply);
        _Other -> loop(Reply)
    end.

%% Watches the process POSIPAKI_NODE serves under POSIPAKI_NAME: the name monitor is resolved by that node when the frame
%% arrives, and the pid comes from the process itself, asked `whois`.
watch() ->
    Node = node_to_watch(),
    Name = list_to_atom(text_of("POSIPAKI_NAME", "posipaki")),
    NameMonitor = monitor(process, {Name, Node}),
    io:format("watching ~p at ~p (~p)~n", [Name, Node, NameMonitor]),
    {Name, Node} ! {self(), <<"whois">>},
    % One moment both waits end at: a term that is not what a wait reads does not move it.
    Deadline = erlang:monotonic_time(millisecond) + 5000,
    await_pid(Name, Node, NameMonitor, Deadline).

%% Waits for the pid the process answers `whois` with, monitors it, and asks the process to end. A term of another shape
%% stays in the mailbox. The name's own end is read here too: a name nobody serves answers `noproc` instead of `whois`.
await_pid(Name, Node, NameMonitor, Deadline) ->
    receive
        {whois, Pid} when is_pid(Pid) ->
            PidMonitor = monitor(process, Pid),
            io:format("whois ~p: ~p (~p)~n", [Name, Pid, PidMonitor]),
            io:format("asking ~p to exit~n", [Pid]),
            Pid ! <<"exit">>,
            await_downs(2, Deadline);
        {'DOWN', NameMonitor, process, {Name, Node}, Reason} ->
            io:format("down ~p {~p,~p} ~p~n", [NameMonitor, Name, Node, Reason])
    after max(0, Deadline - erlang:monotonic_time(millisecond)) ->
            io:format("whois ~p: nothing answered~n", [Name])
    end.

%% Waits for one answer per monitor: the name's, and the pid's.
await_downs(0, _Deadline) ->
    ok;
await_downs(Pending, Deadline) ->
    receive
        {'DOWN', Monitor, process, Watched, Reason} ->
            io:format("down ~p ~p ~p~n", [Monitor, Watched, Reason]),
            await_downs(Pending - 1, Deadline)
    after max(0, Deadline - erlang:monotonic_time(millisecond)) ->
            io:format("no answer for ~p of the monitors~n", [Pending])
    end.

%% The node to watch, as POSIPAKI_NODE says, or a sentence that stops the run.
node_to_watch() ->
    case os:getenv("POSIPAKI_NODE") of
        false ->
            io:format("watch needs POSIPAKI_NODE, e.g. posipaki@192.168.88.27~n", []),
            halt(1);
        Text ->
            list_to_atom(Text)
    end.

text_of(Name, Default) ->
    case os:getenv(Name) of
        false -> Default;
        Text -> Text
    end.
