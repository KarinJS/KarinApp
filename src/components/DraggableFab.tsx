import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, GestureResponderEvent, LayoutChangeEvent, PanResponder, PanResponderGestureState, StyleSheet, Text, View} from 'react-native';
import {Package} from 'lucide-react-native';
import {Colors} from '../theme/colors';

type DraggableFabProps = {
  badgeCount: number;
  colors: Colors;
  onPress: () => void;
};

type DragState = {moved: boolean; origin: {x: number; y: number}};

const FAB_SIZE = 52;
const FAB_MARGIN = 18;
const DRAG_THRESHOLD = 8;

export default function DraggableFab({badgeCount, colors, onPress}: DraggableFabProps) {
  const translate = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const layout = useRef({width: 0, height: 0});
  const position = useRef({x: 0, y: 0});
  const dragState = useRef<DragState>({moved: false, origin: {x: 0, y: 0}});
  const onPressRef = useRef(onPress);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    onPressRef.current = onPress;
  }, [onPress]);

  const bounds = () => ({
    minX: FAB_MARGIN + FAB_SIZE - layout.current.width,
    maxX: 0,
    minY: FAB_MARGIN + FAB_SIZE - layout.current.height,
    maxY: 0,
  });

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const moveTo = (x: number, y: number) => {
    position.current = {x, y};
    translate.setValue({x, y});
  };

  const snapToEdge = () => {
    const {minX, maxX, minY, maxY} = bounds();
    const targetX = position.current.x < (minX + maxX) / 2 ? minX : maxX;
    const targetY = clamp(position.current.y, minY, maxY);
    position.current = {x: targetX, y: targetY};

    Animated.parallel([
      Animated.spring(translate.x, {toValue: targetX, useNativeDriver: true}),
      Animated.spring(translate.y, {toValue: targetY, useNativeDriver: true}),
    ]).start();
  };

  const handleLayout = (event: LayoutChangeEvent) => {
    const {width, height} = event.nativeEvent.layout;
    layout.current = {width, height};
    const {minX, maxX, minY, maxY} = bounds();
    moveTo(clamp(position.current.x, minX, maxX), clamp(position.current.y, minY, maxY));
  };

  const handleMove = (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
    const {minX, maxX, minY, maxY} = bounds();
    if (!dragState.current.moved && Math.abs(gesture.dx) + Math.abs(gesture.dy) > DRAG_THRESHOLD) {
      dragState.current.moved = true;
    }
    const origin = dragState.current.origin;
    moveTo(
      clamp(origin.x + gesture.dx, minX, maxX),
      clamp(origin.y + gesture.dy, minY, maxY),
    );
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onPanResponderGrant: () => {
          translate.stopAnimation(value => {
            position.current = {x: value.x, y: value.y};
            dragState.current = {moved: false, origin: {x: value.x, y: value.y}};
          });
          setPressed(true);
        },
        onPanResponderMove: handleMove,
        onPanResponderRelease: () => {
          setPressed(false);
          if (dragState.current.moved) {
            snapToEdge();
          } else {
            onPressRef.current();
          }
        },
        onPanResponderTerminate: () => {
          setPressed(false);
          if (dragState.current.moved) snapToEdge();
        },
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <View onLayout={handleLayout} pointerEvents="box-none" style={styles.layer}>
      <Animated.View
        accessibilityLabel="安装任务"
        accessibilityRole="button"
        onAccessibilityTap={onPress}
        style={[
          styles.fab,
          {
            backgroundColor: colors.accent,
            transform: translate.getTranslateTransform(),
          },
          pressed ? styles.fabPressed : null,
        ]}
        {...panResponder.panHandlers}>
        <Package color="#fff" size={20} />
        {badgeCount > 0 ? <Text style={styles.badge}>{badgeCount}</Text> : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {...StyleSheet.absoluteFill, zIndex: 2},
  fab: {
    position: 'absolute',
    right: FAB_MARGIN,
    bottom: FAB_MARGIN,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabPressed: {opacity: 0.85},
  badge: {
    position: 'absolute',
    right: -2,
    top: -2,
    color: '#fff',
    backgroundColor: '#dc2626',
    borderRadius: 10,
    minWidth: 18,
    textAlign: 'center',
    fontSize: 11,
  },
});
