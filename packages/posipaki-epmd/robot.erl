%% The other half of the proof: a node that hosts names, and one of them relays a message both ways.
%%
%%   erlc robot.erl
%%   POSIPAKI_NODE=posipaki@192.168.88.27 \
%%     erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% `robot` answers <<"hello ", Text/binary>>, `echo` answers <<"echo: ", Text/binary>>, and `relay` is the round trip:
%% it answers the node that said hi, then asks POSIPAKI_NODE to answer that same node directly.
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
    register(relay, spawn(fun() -> relay(target()) end)),
    io:format("robot, echo and relay registered on ~p~n", [node()]),
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

%% Watches the process POSIPAKI_NODE serves under POSIPAKI_NAME: a monitor on the name, which that node resolves when it
%% arrives, and the pid the process itself answers `whois` with.
watch() ->
    case os:getenv("POSIPAKI_NODE") of
        false ->
            io:format("watch needs POSIPAKI_NODE, e.g. posipaki@192.168.88.27~n", []);
        NodeText ->
            run_watch(list_to_atom(NodeText), list_to_atom(text_of("POSIPAKI_NAME", "posipaki")))
    end.

text_of(Name, Default) ->
    case os:getenv(Name) of
        false -> Default;
        Text -> Text
    end.

run_watch(Node, Name) ->
    ByName = monitor(process, {Name, Node}),
    io:format("watching ~p at ~p (~p)~n", [Name, Node, ByName]),
    {Name, Node} ! {self(), <<"whois">>},
    receive
        {Pid, _Word, _Done} when is_pid(Pid) ->
            ByPid = monitor(process, Pid),
            io:format("whois ~p: ~p (~p)~n", [Name, Pid, ByPid]),
            Pid ! <<"exit">>,
            answered(2)
    after 5000 ->
            io:format("whois ~p: nothing answered~n", [Name])
    end.

answered(0) ->
    ok;
answered(Left) ->
    receive
        {'DOWN', Ref, process, Object, Reason} ->
            io:format("down ~p ~p ~p~n", [Ref, Object, Reason]),
            answered(Left - 1);
        _Other ->
            answered(Left)
    after 5000 ->
            io:format("no answer for ~p of the monitors~n", [Left])
    end.
