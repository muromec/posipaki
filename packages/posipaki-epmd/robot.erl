%% The other half of the proof: a node that hosts a name the script can reach.
%%
%%   erlc robot.erl
%%   erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
%%
%% The process answers every {From, _} with the binary <<"hello robot">>.
-module(robot).
-export([start/0]).

start() ->
    register(robot, spawn(fun loop/0)),
    io:format("robot registered on ~p~n", [node()]),
    receive stop -> ok end.

loop() ->
    receive
        {From, _Msg} -> From ! <<"hello robot">>, loop();
        {From, _Msg, _Ref} -> From ! <<"hello robot">>, loop();
        _Other -> loop()
    end.
