import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, I18nManager, PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import type {GestureResponderEvent} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {TABS} from '../constants/navigation';
import {Colors} from '../theme/colors';
import type {Tab} from '../types';
import GlassBackdrop from './GlassBackdrop';

export {BOTTOM_NAV_HEIGHT} from '../constants/navigation';

const BAR_HEIGHT = 64;
const INNER_PADDING = 6;
const DRAG_THRESHOLD = 6;
const DRAG_CANCEL_MARGIN = 24;

type Props = {
  activeTab: Tab;
  colors: Colors;
  dark: boolean;
  disabled?: boolean;
  onSelect: (tab: Tab) => void;
};

export default function BottomNav({activeTab, colors, dark, disabled = false, onSelect}: Props) {
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const bar = useRef<React.ElementRef<typeof View>>(null);
  const bounds = useRef<{x: number; y: number; width: number; height: number} | null>(null);
  const dragging = useRef(false);
  const selectionAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const position = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;
  const previousWidth = useRef(0);
  const itemWidth = Math.max(0, width - INNER_PADDING * 2) / TABS.length;
  const activeIndex = TABS.findIndex(tab => tab.label === activeTab);
  const direction = I18nManager.isRTL ? -1 : 1;
  const highlightOpacity = dark ? 0.18 : 0.85;
  const edgeOpacity = dark ? 0.06 : 0.32;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted) setReduceMotion(value);
    }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);

  const settleSelection = useCallback((index: number, animate = true, pulse = false) => {
    selectionAnimation.current?.stop();
    const target = index * itemWidth * direction;
    if (reduceMotion || !animate) {
      position.setValue(target);
      stretch.setValue(1);
      return;
    }
    const animation = Animated.parallel([
      Animated.spring(position, {
        toValue: target,
        damping: 22,
        stiffness: 240,
        mass: 0.9,
        useNativeDriver: true,
      }),
      pulse ? Animated.sequence([
        Animated.timing(stretch, {toValue: 1.07, duration: 110, useNativeDriver: true}),
        Animated.spring(stretch, {toValue: 1, damping: 16, stiffness: 220, useNativeDriver: true}),
      ]) : Animated.spring(stretch, {toValue: 1, damping: 20, stiffness: 260, useNativeDriver: true}),
    ]);
    selectionAnimation.current = animation;
    animation.start();
  }, [direction, itemWidth, position, reduceMotion, stretch]);

  useEffect(() => {
    dragging.current = false;
    setPreviewIndex(null);
    settleSelection(activeIndex, width === previousWidth.current, true);
    previousWidth.current = width;
    return () => selectionAnimation.current?.stop();
  }, [activeIndex, disabled, settleSelection, width]);

  // Keep the responder instance stable even when previews or the runtime clock rerender.
  const interaction = useRef({activeIndex, disabled, direction, itemWidth, width, reduceMotion, onSelect, settleSelection});
  interaction.current = {activeIndex, disabled, direction, itemWidth, width, reduceMotion, onSelect, settleSelection};

  const measureBar = useCallback(() => {
    bar.current?.measure((_x, _y, measuredWidth, height, pageX, pageY) => {
      bounds.current = {x: pageX, y: pageY, width: measuredWidth, height};
    });
  }, []);

  const panResponder = useMemo(() => {
    const canDrag = () => {
      const current = interaction.current;
      return !current.disabled && current.itemWidth > 0 && bounds.current !== null &&
        Math.abs(bounds.current.width - current.width) < 1;
    };
    const pointAt = (event: GestureResponderEvent) => {
      const {itemWidth: slotWidth, direction: axisDirection} = interaction.current;
      const frame = bounds.current!;
      const {pageX, pageY} = event.nativeEvent;
      // pageX is independent of the nested Text / SVG node that received the touch.
      const x = axisDirection === 1 ? pageX - frame.x : frame.x + frame.width - pageX;
      const offset = Math.max(0, Math.min((TABS.length - 1) * slotWidth, x - INNER_PADDING - slotWidth / 2));
      return {
        offset,
        index: Math.round(offset / slotWidth),
        inside: pageX >= frame.x - DRAG_CANCEL_MARGIN && pageX <= frame.x + frame.width + DRAG_CANCEL_MARGIN &&
          pageY >= frame.y - DRAG_CANCEL_MARGIN && pageY <= frame.y + frame.height + DRAG_CANCEL_MARGIN,
      };
    };
    const cancel = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setPreviewIndex(null);
      const current = interaction.current;
      current.settleSelection(current.activeIndex);
    };
    const move = (event: GestureResponderEvent) => {
      if (!dragging.current) return;
      if (!canDrag() || event.nativeEvent.touches.length !== 1) {
        cancel();
        return;
      }
      const point = pointAt(event);
      position.setValue(point.offset * interaction.current.direction);
      setPreviewIndex(point.inside ? point.index : null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        measureBar();
        return false;
      },
      // A tap remains a Pressable action; only a deliberate horizontal drag takes over.
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        canDrag() && gesture.numberActiveTouches === 1 && Math.abs(gesture.dx) > DRAG_THRESHOLD &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3,
      onPanResponderGrant: event => {
        if (!canDrag()) return;
        dragging.current = true;
        selectionAnimation.current?.stop();
        stretch.setValue(1);
        if (!interaction.current.reduceMotion) {
          const animation = Animated.spring(stretch, {toValue: 1.08, damping: 20, stiffness: 280, useNativeDriver: true});
          selectionAnimation.current = animation;
          animation.start();
        }
        move(event);
      },
      onPanResponderStart: event => {
        if (event.nativeEvent.touches.length > 1) cancel();
      },
      onPanResponderMove: move,
      onPanResponderRelease: event => {
        if (!dragging.current) return;
        if (!canDrag()) {
          cancel();
          return;
        }
        const point = pointAt(event);
        const current = interaction.current;
        dragging.current = false;
        setPreviewIndex(null);
        const index = point.inside ? point.index : current.activeIndex;
        current.settleSelection(index);
        // Commit once on release; passing over a tab must not mount its screen.
        if (index !== current.activeIndex) current.onSelect(TABS[index].label);
      },
      onPanResponderTerminationRequest: () => true,
      onPanResponderTerminate: cancel,
    });
  }, [measureBar, position, stretch]);

  return (
    <View pointerEvents="box-none" style={[styles.dock, {paddingBottom: insets.bottom + 8}]}>
      <View style={styles.shadow}>
        <View
          ref={bar}
          {...panResponder.panHandlers}
          onLayout={event => {
            bounds.current = null;
            setWidth(event.nativeEvent.layout.width);
            measureBar();
          }}
          style={styles.glass}>
          <GlassBackdrop
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            sourceNativeID="karin-tab-scene"
            blurRadius={18}
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, {backgroundColor: colors.glassTint}]} />
          {width > 0 ? (
            <Svg pointerEvents="none" width={width} height={BAR_HEIGHT} style={StyleSheet.absoluteFill}>
              <Defs>
                <LinearGradient id="glass-rim" x1="0" y1="0" x2="0.3" y2="1">
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity={highlightOpacity} />
                  <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={edgeOpacity} />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity={highlightOpacity * 0.4} />
                </LinearGradient>
              </Defs>
              <Rect x={0.5} y={0.5} width={width - 1} height={BAR_HEIGHT - 1} rx={31.5} fill="none" stroke="url(#glass-rim)" />
            </Svg>
          ) : null}
          {width > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.selection,
                {
                  width: itemWidth,
                  backgroundColor: colors.glassSelected,
                  borderColor: colors.glassSelectedEdge,
                  transform: [
                    {translateX: position},
                    {scaleX: stretch},
                    {scaleY: stretch.interpolate({inputRange: [1, 1.08], outputRange: [1, 1.04]})},
                  ],
                },
              ]}
            />
          ) : null}
          <View accessibilityRole="tablist" style={styles.items}>
            {TABS.map((tab, index) => {
              const active = activeTab === tab.label;
              const Icon = tab.icon;
              const color = (previewIndex ?? activeIndex) === index ? colors.accent : colors.muted;
              return (
                <Pressable
                  key={tab.label}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{selected: active, disabled}}
                  disabled={disabled}
                  onPress={() => onSelect(tab.label)}
                  style={({pressed}) => [styles.item, pressed && !reduceMotion && styles.pressed]}>
                  <Icon size={21} color={color} />
                  <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.label, {color}]}>{tab.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: 12, paddingTop: 8},
  shadow: {width: '100%', maxWidth: 480, height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, boxShadow: '0 4px 18px rgba(30, 12, 20, 0.12)'},
  glass: {flex: 1, borderRadius: BAR_HEIGHT / 2, overflow: 'hidden'},
  items: {flex: 1, flexDirection: 'row', padding: INNER_PADDING},
  selection: {position: 'absolute', start: INNER_PADDING, top: INNER_PADDING, bottom: INNER_PADDING, borderRadius: 26, borderWidth: 1},
  item: {flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 26},
  pressed: {transform: [{scale: 0.94}], opacity: 0.75},
  label: {fontSize: 11, lineHeight: 16, fontWeight: '700', letterSpacing: 0},
});
