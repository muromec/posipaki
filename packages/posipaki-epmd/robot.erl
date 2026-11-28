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

%% The terms this side reads, each by the opcode it starts with: what a served process answers, and what the runtime says
%% when a monitor fires. A term with any other opcode is `unknown`, and each reader ignores what it does not wait for.
parse({whois, Pid}) when is_pid(Pid) ->
    {whois, Pid};
parse({'DOWN', Monitor, process, Watched, Reason}) ->
    {down, Monitor, Watched, Reason};
parse(SomethingElse) ->
    {unknown, SomethingElse}.

%% Watches the process POSIPAKI_NODE serves under POSIPAKI_NAME: the name monitor is resolved by that node when the frame
%% arrives, and the pid comes from the process itself, asked `whois`.
watch() ->
    Node = node_to_watch(),
    Name = list_to_atom(text_of("POSIPAKI_NAME", "posipaki")),
    NameMonitor = monitor(process, {Name, Node}),
    io:format("watching ~p at ~p (~p)~n", [Name, Node, NameMonitor]),
    {Name, Node} ! {self(), <<"whois">>},
    await_pid(Name).

%% Waits for the pid the process answers `whois` with, monitors it, and asks the process to end.
await_pid(Name) ->
    receive
        Message ->
            case parse(Message) of
                {whois, Pid} ->
                    PidMonitor = monitor(process, Pid),
                    io:format("whois ~p: ~p (~p)~n", [Name, Pid, PidMonitor]),
                    io:format("asking ~p to exit~n", [Pid]),
                    Pid ! <<"exit">>,
                    await_downs(2);
                _NotThePid ->
                    await_pid(Name)
            end
    after 5000 ->
            io:format("whois ~p: nothing answered~n", [Name])
    end.

%% Waits for one answer per monitor: the name's, and the pid's.
await_downs(Pending) when Pending =< 0 ->
    ok;
await_downs(Pending) ->
    receive
        Message ->
            case parse(Message) of
                {down, Monitor, Watched, Reason} ->
                    io:format("down ~p ~p ~p~n", [Monitor, Watched, Reason]),
                    await_downs(Pending - 1);
                _NotADown ->
                    await_downs(Pending)
            end
    after 5000 ->
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
