%% The other half of the proof: a node that hosts two names, and answers with what it was sent.
%%
%%   erlc robot.erl
%%   erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% `robot` answers <<"hello ", Text/binary>> and `echo` answers <<"echo: ", Text/binary>>, so a client can tell
%% which name it reached and that the text it sent is the text that came back.
-module(robot).
-export([start/0]).

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
