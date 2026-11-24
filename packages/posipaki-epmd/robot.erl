%% The other half of the proof: a node that hosts names, and one of them relays a message both ways.
%%
%%   erlc robot.erl
%%   POSIPAKI_NODE=posipaki@192.168.88.27 \
%%     erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% `robot` answers <<"hello ", Text/binary>>, `echo` answers <<"echo: ", Text/binary>>, and `relay` is the round trip:
%% it answers the node that said hi, then asks POSIPAKI_NODE to answer that same node directly. `watcher` watches: it
%% is asked to watch a pid and a name, tells that process to exit, and prints the two answers it gets.
%%
%% The node runs with -name rather than -sname: a short-name node refuses to connect to a name whose host is an
%% address, and the posipaki side of this demo is addressed by one.
-module(robot).
-export([start/0]).

start() ->
    register(robot, spawn(fun() -> loop(fun(Text) -> <<"hello ", Text/binary>> end) end)),
    register(echo, spawn(fun() -> loop(fun(Text) -> <<"echo: ", Text/binary>> end) end)),
    register(relay, spawn(fun() -> relay(target()) end)),
    register(watcher, spawn(fun() -> watcher() end)),
    io:format("robot, echo, relay and watcher registered on ~p~n", [node()]),
    receive stop -> ok end.

loop(Reply) ->
    receive
        {From, Text} when is_binary(Text) -> From ! Reply(Text), loop(Reply);
        {From, _Other} -> From ! <<"not a binary">>, loop(Reply);
        _Other -> loop(Reply)
    end.

%% Where the posipaki node is, as this node's environment says.
target() ->
    case os:getenv("POSIPAKI_NODE") of
        false -> undefined;
        Node -> list_to_atom(Node)
    end.

%% Answers the node that said hi, then hands it to the posipaki node, which answers it itself.
relay(undefined) ->
    receive
        {From, _Text} -> From ! <<"relay has no POSIPAKI_NODE">>, relay(undefined)
    end;
relay(Target) ->
    receive
        {From, <<"hi">>} ->
            From ! <<"tomato: hi">>,
            {posipaki, Target} ! {From, <<"hi">>},
            relay(Target);
        {From, _Text} ->
            From ! <<"tomato: only hi">>,
            relay(Target)
    end.

%% Watches the process a `{Pid, Name, <<"ping">>}` names — by the pid, and by the name on that pid's node — tells it to
%% exit, and prints what each watch answers. A watch names the process it is on, so the answer carries what was asked:
%% the pid for the first, the name for the second.
watcher() ->
    receive
        {Pid, Name, <<"ping">>} when is_pid(Pid), is_atom(Name) ->
            ByPid = monitor(process, Pid),
            ByName = monitor(process, {Name, node(Pid)}),
            io:format("watching ~p (~p) and ~p at ~p (~p)~n", [Pid, ByPid, Name, node(Pid), ByName]),
            Pid ! <<"exit">>,
            watcher();
        {'DOWN', Ref, process, Object, Reason} ->
            io:format("down ~p ~p ~p~n", [Ref, Object, Reason]),
            watcher();
        _Other ->
            watcher()
    end.
